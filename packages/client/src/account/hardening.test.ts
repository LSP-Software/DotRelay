import { describe, expect, test } from "bun:test";
import {
  ARGON2ID_POLICY,
  type CborValue,
  encodeProtocolObject,
  exportSigningPublicKey,
  generateSigningKeyPair,
  type ProtocolObject,
  parseProtocolObject,
  uuidToBytes,
} from "@dotrelay/contracts";
import {
  createAccountKeyWrapper,
  extractPasskeyPrfOutput,
  generateAccountMasterKey,
  generateRecoveryCode,
  type PasswordKdfParameters,
  parseAccountKeyWrapper,
  passkeyPrfSupported,
  unwrapAccountKeyWrapper,
  WRAPPER_TYPE,
} from "../index";

const SERVER_PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = new Uint8Array(16).fill(7);
const DEVICE_ID = new Uint8Array(16).fill(9);

const encode = (object: ProtocolObject): Uint8Array =>
  encodeProtocolObject(object);

// Copy a parsed object into a mutable field map so a single bound field can be
// tampered with and re-encoded to probe the open path.
const flipField = (
  object: ProtocolObject,
  field: number,
  value: CborValue,
): Map<number, CborValue> => {
  const copy = new Map<number, CborValue>(object);
  copy.set(field, value);
  return copy;
};

const baseInput = (
  signing: CryptoKeyPair,
  accountMasterKey: Uint8Array,
  kind: Parameters<typeof createAccountKeyWrapper>[0]["kind"],
) =>
  Object.freeze({
    serverProfileId: SERVER_PROFILE_ID,
    userId: USER_ID,
    deviceId: DEVICE_ID,
    userIdentityGeneration: 1,
    createdAtMs: 1_700_000_000_000,
    accountMasterKey,
    signingPrivateKey: signing.privateKey,
    kind,
  });

// Trusted keys + identity context built from the creator's signing key, so a
// self-created object verifies against its own trusted key on the open path.
const selfVerification = async (signing: CryptoKeyPair) =>
  Object.freeze({
    trustedKeys: Object.freeze({
      keys: [await exportSigningPublicKey(signing.publicKey)],
    }),
    context: Object.freeze({
      serverProfileId: uuidToBytes(SERVER_PROFILE_ID),
      userId: USER_ID,
      deviceId: DEVICE_ID,
      userIdentityGeneration: 1,
    }),
  });

describe("account key wire-format hardening", () => {
  test("a version-1 account key object is rejected at the wire gate", async () => {
    const signing = await generateSigningKeyPair();
    const accountMasterKey = generateAccountMasterKey();
    const wrapper = await createAccountKeyWrapper(
      baseInput(signing, accountMasterKey, {
        type: "recoveryCode",
        recoveryCode: generateRecoveryCode(),
      }),
    );
    // Control: the freshly created v2 object parses and reports version 2.
    expect(parseProtocolObject(encode(wrapper.object)).get(88)).toBe(2);
    // Flip the format version back to 1: the only structural invariant broken
    // is the v1->v2 wire gate, so parse must reject it. Pre the protocol.ts
    // regression fix this gate was silently skipped and v1 objects were
    // accepted.
    const v1 = flipField(wrapper.object, 88, 1);
    expect(() => parseProtocolObject(encode(v1))).toThrow();
  });

  test("out-of-policy password KDF is rejected at create before any allocation", async () => {
    const signing = await generateSigningKeyPair();
    const password = new TextEncoder().encode("policy probe");
    const outOfPolicy: PasswordKdfParameters[] = [
      // memory above the policy ceiling (512 MiB)
      {
        memoryKiB: ARGON2ID_POLICY.maxMemoryKiB + 1,
        iterations: 1,
        parallelism: 1,
      },
      // iterations above the policy ceiling
      {
        memoryKiB: 8,
        iterations: ARGON2ID_POLICY.maxIterations + 1,
        parallelism: 1,
      },
      // parallelism above the policy ceiling
      {
        memoryKiB: 8,
        iterations: 1,
        parallelism: ARGON2ID_POLICY.maxParallelism + 1,
      },
    ];
    for (const kdf of outOfPolicy) {
      await expect(
        createAccountKeyWrapper(
          baseInput(signing, generateAccountMasterKey(), {
            type: "password",
            password,
            kdf,
          }),
        ),
      ).rejects.toThrow("out of policy");
    }
  });

  test("a passkey PRF output of the wrong length is rejected at create and unwrap", async () => {
    const signing = await generateSigningKeyPair();
    const accountMasterKey = generateAccountMasterKey();
    const credentialId = new Uint8Array(16).fill(3);
    const prfInput = new Uint8Array(32).fill(5);
    const prfOutput = new Uint8Array(32).fill(6);
    const wrapper = await createAccountKeyWrapper(
      baseInput(signing, accountMasterKey, {
        type: "passkeyPrf",
        credentialId,
        prfInput,
        prfOutput,
      }),
    );
    expect(wrapper.wrapperType).toBe(WRAPPER_TYPE.passkeyPrf);
    // A 32-byte output unwraps to the exact sealed key material.
    const recovered = await unwrapAccountKeyWrapper(
      parseAccountKeyWrapper(encode(wrapper.object)),
      { prfOutput },
      await selfVerification(signing),
    );
    expect(recovered).toEqual(accountMasterKey);
    // A 64-byte output is rejected at create ...
    await expect(
      createAccountKeyWrapper(
        baseInput(signing, generateAccountMasterKey(), {
          type: "passkeyPrf",
          credentialId,
          prfInput,
          prfOutput: new Uint8Array(64),
        }),
      ),
    ).rejects.toThrow();
    // ... and on unwrap of a well-formed 32-byte wrapper.
    await expect(
      unwrapAccountKeyWrapper(
        parseAccountKeyWrapper(encode(wrapper.object)),
        { prfOutput: new Uint8Array(64) },
        await selfVerification(signing),
      ),
    ).rejects.toThrow();
  });

  test("tampering a signed AAD-bound field rejects before decryption", async () => {
    const signing = await generateSigningKeyPair();
    const accountMasterKey = generateAccountMasterKey();
    const recoveryCode = generateRecoveryCode();
    const wrapper = await createAccountKeyWrapper(
      baseInput(signing, accountMasterKey, {
        type: "recoveryCode",
        recoveryCode,
      }),
    );
    // The un-tampered wrapper recovers the exact key material.
    const recovered = await unwrapAccountKeyWrapper(
      parseAccountKeyWrapper(encode(wrapper.object)),
      { recoveryCode },
      await selfVerification(signing),
    );
    expect(recovered).toEqual(accountMasterKey);
    // Flip a field the seal-time AAD binds (user id). Because the AAD is a
    // subset of the signed fields, the Ed25519 signature over the object can no
    // longer be authorized by the trusted key. Feed the tampered object straight
    // to the open path (bypassing byte validation) so the verify-before-decrypt
    // gate is what rejects it, before any KDF or GCM open runs.
    const tampered = flipField(
      wrapper.object,
      9,
      new Uint8Array(16).fill(0x5a),
    );
    const tamperedWrapper = Object.freeze({
      object: tampered,
      wrapperType: wrapper.wrapperType,
      wrapperId: wrapper.wrapperId,
      salt: wrapper.salt,
      iv: wrapper.iv,
      ciphertext: wrapper.ciphertext,
    });
    await expect(
      unwrapAccountKeyWrapper(
        tamperedWrapper,
        { recoveryCode },
        await selfVerification(signing),
      ),
    ).rejects.toThrow();
  });
});

describe("webauthn prf extraction (R4)", () => {
  test("extracts a 32-byte PRF extension output", () => {
    const prf = new ArrayBuffer(32);
    new Uint8Array(prf).set(Array.from({ length: 32 }, (_, i) => i));
    const out = extractPasskeyPrfOutput({ extensions: { prf } });
    expect(out).not.toBeNull();
    const bytes = out as Uint8Array;
    expect(bytes.length).toBe(32);
    expect(bytes[31]).toBe(31);
  });

  test("returns null for a PRF output of the wrong length", () => {
    expect(
      extractPasskeyPrfOutput({ extensions: { prf: new ArrayBuffer(64) } }),
    ).toBeNull();
    expect(
      extractPasskeyPrfOutput({ extensions: { prf: new ArrayBuffer(16) } }),
    ).toBeNull();
  });

  test("returns null when the platform returned no PRF extension", () => {
    expect(extractPasskeyPrfOutput({})).toBeNull();
    expect(extractPasskeyPrfOutput({ extensions: {} })).toBeNull();
  });

  test("feature-detects the PRF extension surface", () => {
    expect(
      passkeyPrfSupported({
        PublicKeyCredential: class {},
        navigator: { credentials: { get: () => {} } },
      }),
    ).toBe(true);
    expect(passkeyPrfSupported({})).toBe(false);
    // PublicKeyCredential present but no credentials.get is not usable.
    expect(passkeyPrfSupported({ PublicKeyCredential: class {} })).toBe(false);
    // credentials present but no get() function is not usable.
    expect(
      passkeyPrfSupported({
        PublicKeyCredential: class {},
        navigator: { credentials: {} },
      }),
    ).toBe(false);
  });
});
