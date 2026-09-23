import { describe, expect, test } from "bun:test";
import {
  encodeProtocolObject,
  exportSigningPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  type ProtocolObject,
  parseProtocolObject,
  uuidToBytes,
  verifyProtocolObject,
} from "@dotrelay/contracts";
import {
  createAccountKeyEnvelope,
  createAccountKeyTransfer,
  createAccountKeyWrapper,
  DEFAULT_PASSWORD_KDF,
  decodeRecoveryCode,
  encodeRecoveryCode,
  generateAccountMasterKey,
  generateRecoveryCode,
  KEY_ENVELOPE_TYPE,
  openAccountKeyEnvelope,
  openAccountKeyTransfer,
  parseAccountKeyEnvelope,
  parseAccountKeyTransfer,
  parseAccountKeyWrapper,
  unwrapAccountKeyWrapper,
  WRAPPER_TYPE,
} from "../index";

const SERVER_PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = new Uint8Array(16).fill(7);
const DEVICE_ID = new Uint8Array(16).fill(9);
const PEER_DEVICE_ID = "55555555-5555-4555-8555-555555555555";

const FAST_KDF = Object.freeze({
  memoryKiB: 8,
  iterations: 1,
  parallelism: 1,
});

const encode = (object: ProtocolObject): Uint8Array =>
  encodeProtocolObject(object);

const verifySigned = async (
  object: ProtocolObject,
  publicKey: CryptoKey,
): Promise<boolean> => {
  const signature = object.get(4);
  if (!(signature instanceof Uint8Array))
    throw new Error("object is missing its signature");
  return verifyProtocolObject(object, signature, publicKey);
};

// Build the verification argument (trusted keys + identity context) from the
// signing key pair that created the object, so a self-created object verifies
// against its own trusted key.
const wrapperVerification = async (
  signing: CryptoKeyPair,
): Promise<
  Readonly<{
    readonly trustedKeys: { readonly keys: readonly Uint8Array[] };
    readonly context: Readonly<{
      readonly serverProfileId: Uint8Array;
      readonly userId: Uint8Array;
      readonly deviceId: Uint8Array;
      readonly userIdentityGeneration: number;
    }>;
  }>
> => {
  const trustedKeys = Object.freeze({
    keys: [await exportSigningPublicKey(signing.publicKey)],
  });
  return Object.freeze({
    trustedKeys,
    context: Object.freeze({
      serverProfileId: uuidToBytes(SERVER_PROFILE_ID),
      userId: USER_ID,
      deviceId: DEVICE_ID,
      userIdentityGeneration: 1,
    }),
  });
};

const envelopeVerification = async (
  signing: CryptoKeyPair,
  context: Readonly<{
    readonly envelopeType: number;
    readonly projectId?: Uint8Array;
    readonly projectEpoch?: number;
    readonly ownerUserId?: Uint8Array;
    readonly valueGeneration?: number;
  }>,
): Promise<
  Readonly<{
    readonly trustedKeys: { readonly keys: readonly Uint8Array[] };
    readonly context: Readonly<{
      readonly serverProfileId: Uint8Array;
      readonly userId: Uint8Array;
      readonly deviceId: Uint8Array;
      readonly userIdentityGeneration: number;
    }> & {
      readonly envelopeType: number;
      readonly projectId?: Uint8Array;
      readonly projectEpoch?: number;
      readonly ownerUserId?: Uint8Array;
      readonly valueGeneration?: number;
    };
  }>
> => {
  const trustedKeys = Object.freeze({
    keys: [await exportSigningPublicKey(signing.publicKey)],
  });
  return Object.freeze({
    trustedKeys,
    context: Object.freeze({
      serverProfileId: uuidToBytes(SERVER_PROFILE_ID),
      userId: USER_ID,
      deviceId: DEVICE_ID,
      userIdentityGeneration: 1,
      ...context,
    }),
  });
};

const transferVerification = async (
  signing: CryptoKeyPair,
  ownDeviceId: Uint8Array,
): Promise<
  Readonly<{
    readonly trustedKeys: { readonly keys: readonly Uint8Array[] };
    readonly context: Readonly<{
      readonly serverProfileId: Uint8Array;
      readonly userId: Uint8Array;
      readonly deviceId: Uint8Array;
      readonly userIdentityGeneration: number;
      readonly ownDeviceId: Uint8Array;
      readonly nowMs: number;
    }>;
  }>
> => {
  const trustedKeys = Object.freeze({
    keys: [await exportSigningPublicKey(signing.publicKey)],
  });
  return Object.freeze({
    trustedKeys,
    context: Object.freeze({
      serverProfileId: uuidToBytes(SERVER_PROFILE_ID),
      userId: USER_ID,
      deviceId: DEVICE_ID,
      userIdentityGeneration: 1,
      ownDeviceId,
      nowMs: 0,
    }),
  });
};

describe("recovery code codec", () => {
  test("round trips 32 bytes through Crockford base32", () => {
    const code = generateRecoveryCode();
    const text = encodeRecoveryCode(code);
    expect(text).toHaveLength(64);
    expect(text).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){12}$/);
    expect(decodeRecoveryCode(text)).toEqual(code);
  });

  test("accepts lowercase input and rejects malformed codes", () => {
    const code = generateRecoveryCode();
    const text = encodeRecoveryCode(code);
    expect(decodeRecoveryCode(text.toLowerCase())).toEqual(code);
    expect(() => decodeRecoveryCode(text.slice(0, -2))).toThrow(
      "recovery code is malformed",
    );
    const tampered = `${encodeRecoveryCode(new Uint8Array(32)).slice(0, -1)}V`;
    expect(() => decodeRecoveryCode(tampered)).toThrow(
      "recovery code is malformed",
    );
    expect(() => encodeRecoveryCode(new Uint8Array(31))).toThrow();
  });
});

describe("account key wrappers", () => {
  test("password wrapper seals and recovers the Account Master Key", async () => {
    const signing = await generateSigningKeyPair();
    const accountMasterKey = generateAccountMasterKey();
    const password = new TextEncoder().encode("correct horse battery staple");
    const wrapper = await createAccountKeyWrapper({
      serverProfileId: SERVER_PROFILE_ID,
      userId: USER_ID,
      deviceId: DEVICE_ID,
      userIdentityGeneration: 1,
      createdAtMs: 1_700_000_000_000,
      accountMasterKey,
      signingPrivateKey: signing.privateKey,
      kind: { type: "password", password },
    });
    expect(wrapper.wrapperType).toBe(WRAPPER_TYPE.password);
    expect(wrapper.kdf).toEqual(DEFAULT_PASSWORD_KDF);
    const object = parseProtocolObject(encode(wrapper.object));
    expect(object.get(1)).toBe(20);
    expect(object.get(88)).toBe(2);
    expect(object.get(71)).toBe(32);
    await expect(verifySigned(object, signing.publicKey)).resolves.toBe(true);
    const verification = await wrapperVerification(signing);
    const recovered = await unwrapAccountKeyWrapper(
      parseAccountKeyWrapper(encode(wrapper.object)),
      { password },
      verification,
    );
    expect(recovered).toEqual(accountMasterKey);
    await expect(
      unwrapAccountKeyWrapper(
        wrapper,
        { password: new TextEncoder().encode("wrong password") },
        verification,
      ),
    ).rejects.toThrow();
    await expect(
      unwrapAccountKeyWrapper(
        wrapper,
        { recoveryCode: generateRecoveryCode() },
        verification,
      ),
    ).rejects.toThrow();
  }, 60_000);

  test("recovery code wrapper recovers the Account Master Key", async () => {
    const signing = await generateSigningKeyPair();
    const accountMasterKey = generateAccountMasterKey();
    const recoveryCode = generateRecoveryCode();
    const wrapper = await createAccountKeyWrapper({
      serverProfileId: SERVER_PROFILE_ID,
      userId: USER_ID,
      deviceId: DEVICE_ID,
      userIdentityGeneration: 1,
      createdAtMs: 1_700_000_000_000,
      accountMasterKey,
      signingPrivateKey: signing.privateKey,
      kind: { type: "recoveryCode", recoveryCode },
    });
    expect(wrapper.wrapperType).toBe(WRAPPER_TYPE.recoveryCode);
    expect(wrapper.credentialId).toBeUndefined();
    expect(wrapper.prfInput).toBeUndefined();
    const recovered = await unwrapAccountKeyWrapper(
      parseAccountKeyWrapper(encode(wrapper.object)),
      { recoveryCode },
      await wrapperVerification(signing),
    );
    expect(recovered).toEqual(accountMasterKey);
  });

  test("passkey wrapper stores PRF input and uses PRF output to seal", async () => {
    const signing = await generateSigningKeyPair();
    const accountMasterKey = generateAccountMasterKey();
    const credentialId = new Uint8Array(16).fill(3);
    const prfInput = new Uint8Array(32).fill(5);
    const prfOutput = new Uint8Array(32).fill(6);
    const wrapper = await createAccountKeyWrapper({
      serverProfileId: SERVER_PROFILE_ID,
      userId: USER_ID,
      deviceId: DEVICE_ID,
      userIdentityGeneration: 1,
      createdAtMs: 1_700_000_000_000,
      accountMasterKey,
      signingPrivateKey: signing.privateKey,
      kind: { type: "passkeyPrf", credentialId, prfInput, prfOutput },
    });
    expect(wrapper.wrapperType).toBe(WRAPPER_TYPE.passkeyPrf);
    expect(wrapper.credentialId).toEqual(credentialId);
    expect(wrapper.prfInput).toEqual(prfInput);
    expect(wrapper.kdf).toBeUndefined();
    const verification = await wrapperVerification(signing);
    const recovered = await unwrapAccountKeyWrapper(
      parseAccountKeyWrapper(encode(wrapper.object)),
      { prfOutput },
      verification,
    );
    expect(recovered).toEqual(accountMasterKey);
    await expect(
      unwrapAccountKeyWrapper(
        wrapper,
        { password: new Uint8Array(4) },
        verification,
      ),
    ).rejects.toThrow();
  });

  test("password wrapper with fast KDF parameters persists them", async () => {
    const signing = await generateSigningKeyPair();
    const accountMasterKey = generateAccountMasterKey();
    const password = new TextEncoder().encode("fast");
    const wrapper = await createAccountKeyWrapper({
      serverProfileId: SERVER_PROFILE_ID,
      userId: USER_ID,
      deviceId: DEVICE_ID,
      userIdentityGeneration: 1,
      createdAtMs: 1_700_000_000_000,
      accountMasterKey,
      signingPrivateKey: signing.privateKey,
      kind: { type: "password", password, kdf: FAST_KDF },
    });
    expect(wrapper.kdf).toEqual(FAST_KDF);
    const recovered = await unwrapAccountKeyWrapper(
      parseAccountKeyWrapper(encode(wrapper.object)),
      { password },
      await wrapperVerification(signing),
    );
    expect(recovered).toEqual(accountMasterKey);
  });
});

describe("account key envelopes", () => {
  test("seals a Project Epoch Key under the Account Master Key", async () => {
    const signing = await generateSigningKeyPair();
    const accountMasterKey = generateAccountMasterKey();
    const contentKey = new Uint8Array(32).fill(11);
    const envelope = await createAccountKeyEnvelope({
      serverProfileId: SERVER_PROFILE_ID,
      userId: USER_ID,
      deviceId: DEVICE_ID,
      createdAtMs: 1_700_000_000_000,
      accountMasterKey,
      signingPrivateKey: signing.privateKey,
      kind: {
        type: "projectEpochKey",
        projectId: new Uint8Array(16).fill(3),
        projectEpoch: 2,
        contentKey,
      },
    });
    expect(envelope.envelopeType).toBe(KEY_ENVELOPE_TYPE.projectEpochKey);
    const parsed = parseAccountKeyEnvelope(encode(envelope.object));
    expect(parsed.projectEpoch).toBe(2);
    const verification = await envelopeVerification(signing, {
      envelopeType: KEY_ENVELOPE_TYPE.projectEpochKey,
      projectId: parsed.projectId,
      projectEpoch: parsed.projectEpoch,
    });
    expect(
      await openAccountKeyEnvelope(parsed, accountMasterKey, verification),
    ).toEqual(contentKey);
    await expect(
      openAccountKeyEnvelope(parsed, generateAccountMasterKey(), verification),
    ).rejects.toThrow();
  });

  test("seals a User Value Key under the Account Master Key", async () => {
    const signing = await generateSigningKeyPair();
    const accountMasterKey = generateAccountMasterKey();
    const contentKey = new Uint8Array(32).fill(12);
    const envelope = await createAccountKeyEnvelope({
      serverProfileId: SERVER_PROFILE_ID,
      userId: USER_ID,
      deviceId: DEVICE_ID,
      createdAtMs: 1_700_000_000_000,
      accountMasterKey,
      signingPrivateKey: signing.privateKey,
      kind: {
        type: "userValueKey",
        ownerUserId: USER_ID,
        valueGeneration: 3,
        contentKey,
      },
    });
    expect(envelope.envelopeType).toBe(KEY_ENVELOPE_TYPE.userValueKey);
    const parsed = parseAccountKeyEnvelope(encode(envelope.object));
    expect(parsed.valueGeneration).toBe(3);
    expect(parsed.projectId).toBeUndefined();
    expect(
      await openAccountKeyEnvelope(
        parsed,
        accountMasterKey,
        await envelopeVerification(signing, {
          envelopeType: KEY_ENVELOPE_TYPE.userValueKey,
          ownerUserId: USER_ID,
          valueGeneration: parsed.valueGeneration,
        }),
      ),
    ).toEqual(contentKey);
  });
});

describe("account key transfers", () => {
  test("seals the Account Master Key to a Device X25519 key", async () => {
    const signing = await generateSigningKeyPair();
    const recipient = await generateEncryptionKeyPair();
    const accountMasterKey = generateAccountMasterKey();
    const transfer = await createAccountKeyTransfer({
      serverProfileId: SERVER_PROFILE_ID,
      userId: USER_ID,
      deviceId: DEVICE_ID,
      createdAtMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_600_000,
      accountMasterKey,
      recipientDeviceId: PEER_DEVICE_ID,
      recipientEncryptionPublicKey: recipient.publicKey,
      signingPrivateKey: signing.privateKey,
    });
    expect(transfer.transferId).toHaveLength(16);
    const parsed = parseAccountKeyTransfer(encode(transfer.object));
    expect(parsed.expiresAtMs).toBe(1_700_000_600_000);
    const verification = await transferVerification(
      signing,
      uuidToBytes(PEER_DEVICE_ID),
    );
    expect(
      await openAccountKeyTransfer(parsed, recipient.privateKey, verification),
    ).toEqual(accountMasterKey);
    const stranger = await generateEncryptionKeyPair();
    await expect(
      openAccountKeyTransfer(parsed, stranger.privateKey, verification),
    ).rejects.toThrow();
  });
});
