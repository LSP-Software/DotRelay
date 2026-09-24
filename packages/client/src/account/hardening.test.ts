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
  createPasskeyWithPrf,
  extractPasskeyPrfOutput,
  generateAccountMasterKey,
  generateRecoveryCode,
  PasskeyPrfError,
  type PasskeyPrfPlatform,
  type PasswordKdfParameters,
  parseAccountKeyWrapper,
  passkeyPrfSupported,
  runPasskeyAssertion,
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

describe("webauthn prf extraction (WebAuthn Level 3)", () => {
  const outputBuffer = (bytes: Uint8Array): ArrayBuffer => {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  };

  // Authentication supplies prf.results.first and does not report enabled.
  // Registration reports prf.enabled. The invented `supported` flag is not
  // part of either response.
  test("an assertion result without supported or enabled unlocks the existing account master key", async () => {
    const signing = await generateSigningKeyPair();
    const accountMasterKey = generateAccountMasterKey();
    const credentialIdBytes = new Uint8Array(32).fill(3);
    const prfInputBytes = new Uint8Array(32).fill(5);
    const prfOutput = new Uint8Array(32);
    prfOutput.set(Array.from({ length: 32 }, (_, index) => index + 1));
    const wrapper = await createAccountKeyWrapper(
      baseInput(signing, accountMasterKey, {
        type: "passkeyPrf",
        credentialId: credentialIdBytes,
        prfInput: prfInputBytes,
        prfOutput,
      }),
    );
    const platform: PasskeyPrfPlatform = {
      PublicKeyCredential: {
        isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
      },
      crypto: globalThis.crypto,
      navigator: {
        credentials: {
          get: async () => ({
            id: "spec-assertion",
            rawId: outputBuffer(credentialIdBytes),
            type: "public-key",
            getClientExtensionResults: () =>
              Object.freeze({
                prf: { results: { first: outputBuffer(prfOutput) } },
              }),
          }),
          create: async () => {
            throw new Error("creation is not part of an unlock");
          },
        },
      },
    };
    const asserted = await runPasskeyAssertion(
      platform,
      credentialIdBytes,
      prfInputBytes,
    );
    expect(asserted).toEqual(prfOutput);
    const recovered = await unwrapAccountKeyWrapper(
      parseAccountKeyWrapper(encode(wrapper.object)),
      { prfOutput: asserted },
      await selfVerification(signing),
    );
    expect(recovered).toEqual(accountMasterKey);
  });

  test("a creation response with enabled false is not a recovery method", async () => {
    const prfOutput = new Uint8Array(32).fill(9);
    const credentialIdBytes = new Uint8Array(16).fill(4);
    let assertions = 0;
    const platform: PasskeyPrfPlatform = {
      PublicKeyCredential: {
        isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
      },
      crypto: globalThis.crypto,
      navigator: {
        credentials: {
          create: async () => ({
            id: "disabled-prf",
            rawId: outputBuffer(credentialIdBytes),
            type: "public-key",
            getClientExtensionResults: () =>
              Object.freeze({
                prf: {
                  enabled: false,
                  supported: true,
                  results: { first: outputBuffer(prfOutput) },
                },
              }),
          }),
          get: async () => {
            assertions += 1;
            return {
              id: "disabled-prf",
              rawId: outputBuffer(credentialIdBytes),
              type: "public-key",
              getClientExtensionResults: () =>
                Object.freeze({
                  prf: {
                    supported: true,
                    results: { first: outputBuffer(prfOutput) },
                  },
                }),
            };
          },
          delete: async () => undefined,
        },
      },
    };
    await expect(
      createPasskeyWithPrf(
        platform,
        new Uint8Array(32).fill(5),
        new Uint8Array(16).fill(1),
      ),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(assertions).toBe(0);
  });

  test("a creation response with enabled true and no result is confirmed by an assertion", async () => {
    const prfOutput = new Uint8Array(32).fill(8);
    const credentialIdBytes = new Uint8Array(16).fill(6);
    const platform: PasskeyPrfPlatform = {
      PublicKeyCredential: {
        isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
      },
      crypto: globalThis.crypto,
      navigator: {
        credentials: {
          create: async () => ({
            id: "confirm-prf",
            rawId: outputBuffer(credentialIdBytes),
            type: "public-key",
            getClientExtensionResults: () =>
              Object.freeze({ prf: { enabled: true } }),
          }),
          get: async () => ({
            id: "confirm-prf",
            rawId: outputBuffer(credentialIdBytes),
            type: "public-key",
            getClientExtensionResults: () =>
              Object.freeze({
                prf: { results: { first: outputBuffer(prfOutput) } },
              }),
          }),
        },
      },
    };
    const created = await createPasskeyWithPrf(
      platform,
      new Uint8Array(32).fill(5),
      new Uint8Array(16).fill(1),
    );
    expect(created.credentialId).toEqual(credentialIdBytes);
    expect(created.prfOutput).toEqual(prfOutput);
  });

  const extensionResults = (
    prf: Readonly<Record<string, unknown>> | undefined,
  ): Readonly<Record<string, unknown>> =>
    Object.freeze(prf !== undefined ? Object.freeze({ prf }) : {});

  test("extracts a 32-byte PRF extension output from the client extension results", () => {
    const prf = new ArrayBuffer(32);
    new Uint8Array(prf).set(Array.from({ length: 32 }, (_, i) => i));
    const out = extractPasskeyPrfOutput(
      extensionResults({ results: { first: prf } }),
    );
    expect(out).not.toBeNull();
    expect(out).toHaveLength(32);
    expect(out?.[31]).toBe(31);
  });

  test("returns null for a PRF output of the wrong length", () => {
    expect(
      extractPasskeyPrfOutput(
        extensionResults({ results: { first: new ArrayBuffer(64) } }),
      ),
    ).toBeNull();
    expect(
      extractPasskeyPrfOutput(
        extensionResults({ results: { first: new ArrayBuffer(16) } }),
      ),
    ).toBeNull();
  });

  test("returns null when the platform reported no PRF output", () => {
    expect(extractPasskeyPrfOutput({})).toBeNull();
    expect(extractPasskeyPrfOutput(undefined)).toBeNull();
    expect(extractPasskeyPrfOutput(extensionResults({}))).toBeNull();
    expect(
      extractPasskeyPrfOutput(extensionResults({ enabled: false })),
    ).toBeNull();
    expect(
      extractPasskeyPrfOutput(extensionResults({ enabled: true })),
    ).toBeNull();
    expect(
      extractPasskeyPrfOutput(extensionResults({ results: {} })),
    ).toBeNull();
    expect(
      extractPasskeyPrfOutput(
        Object.freeze({ prf: { enabled: false }, appid: true }),
      ),
    ).toBeNull();
  });

  test("feature-detects the PRF extension surface", () => {
    expect(
      passkeyPrfSupported({
        PublicKeyCredential: {
          isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
        },
        navigator: {
          credentials: {
            get: async () => {
              throw new Error("unreachable");
            },
            create: async () => {
              throw new Error("unreachable");
            },
          },
        },
      }),
    ).toBe(true);
    expect(passkeyPrfSupported({})).toBe(false);
    // PublicKeyCredential present but no platform-authenticator probe is not
    // usable.
    expect(passkeyPrfSupported({ PublicKeyCredential: {} })).toBe(false);
    // credentials present but no get() function is not usable.
    expect(
      passkeyPrfSupported({
        PublicKeyCredential: {
          isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
        },
        navigator: {
          credentials: {
            create: async () => {
              throw new Error("unreachable");
            },
          },
        },
      }),
    ).toBe(false);
  });
});

describe("webauthn prf ceremonies (faithful platform double)", () => {
  // A test double implementing the real PublicKeyCredential interface the
  // browser exposes: the PRF output is derived from the credential id and the
  // requested PRF input (deterministic stand-in for the authenticator's
  // HMAC), exactly like a real credential-bound PRF. The double is labeled a
  // double on purpose: Playwright cannot emulate the PRF extension, and a
  // synthetic response object is not a passkey ceremony.
  const credentialIdBytes = new Uint8Array(32).fill(3);
  const prfInputBytes = new Uint8Array(32).fill(5);

  const expectedPrfOutput = async (
    credentialId: Uint8Array,
  ): Promise<Uint8Array> => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new Uint8Array([...credentialId, ...prfInputBytes]),
    );
    return new Uint8Array(digest);
  };

  const copyBuffer = (bytes: Uint8Array): ArrayBuffer => {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  };

  const makeCredential = (
    ceremony: "authentication" | "registration",
    prfOutput: Uint8Array | null,
    registration: "output" | "confirm" | "disabled" = "output",
  ) => ({
    id: "test-credential",
    rawId: copyBuffer(credentialIdBytes),
    type: "public-key",
    getClientExtensionResults: () => {
      if (ceremony === "authentication") {
        return Object.freeze(
          prfOutput
            ? { prf: { results: { first: copyBuffer(prfOutput) } } }
            : { prf: {} },
        );
      }
      if (registration === "disabled")
        return Object.freeze({ prf: { enabled: false } });
      if (registration === "confirm" || !prfOutput)
        return Object.freeze({ prf: { enabled: true } });
      return Object.freeze({
        prf: { enabled: true, results: { first: copyBuffer(prfOutput) } },
      });
    },
  });

  const makePlatform = (
    behavior: Readonly<{
      assertionResult:
        | "output"
        | "no-output"
        | "cancel"
        | "no-credential"
        | "throw";
      creationResult: "output" | "confirm" | "disabled" | "cancel";
    }>,
  ) => {
    const seen: {
      getOptions: Array<Readonly<{ readonly publicKey: unknown }>>;
      createOptions: Array<Readonly<{ readonly publicKey: unknown }>>;
      deleted: number;
    } = { getOptions: [], createOptions: [], deleted: 0 };
    const platform: PasskeyPrfPlatform = {
      PublicKeyCredential: {
        isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
      },
      crypto: globalThis.crypto,
      navigator: {
        credentials: {
          get: async (options) => {
            seen.getOptions.push(options);
            switch (behavior.assertionResult) {
              case "output": {
                const output = await expectedPrfOutput(credentialIdBytes);
                return makeCredential("authentication", output);
              }
              case "no-output":
                return makeCredential("authentication", null);
              case "cancel":
                throw new DOMException("cancelled", "NotAllowedError");
              case "no-credential":
                throw new DOMException(
                  "no matching credential",
                  "CredentialNotAllowedError",
                );
              default:
                throw new Error("authenticator gone");
            }
          },
          create: async (options) => {
            seen.createOptions.push(options);
            if (behavior.creationResult === "cancel")
              throw new DOMException("cancelled", "NotAllowedError");
            const output =
              behavior.creationResult === "output"
                ? new Uint8Array(await expectedPrfOutput(credentialIdBytes))
                : null;
            return makeCredential(
              "registration",
              output,
              behavior.creationResult === "cancel"
                ? "output"
                : behavior.creationResult,
            );
          },
          delete: async () => {
            seen.deleted += 1;
          },
        },
      },
    };
    return { platform, seen };
  };

  const capture = (promise: Promise<unknown>): Promise<PasskeyPrfError> =>
    promise.then(
      () => {
        throw new Error("expected the ceremony to fail");
      },
      (failure: unknown) => {
        if (!(failure instanceof PasskeyPrfError)) throw failure;
        return failure;
      },
    );

  test("an assertion requesting the PRF extension returns the 32-byte output", async () => {
    const { platform, seen } = makePlatform({
      assertionResult: "output",
      creationResult: "output",
    });
    const output = await runPasskeyAssertion(
      platform,
      credentialIdBytes,
      prfInputBytes,
    );
    expect(output).toEqual(await expectedPrfOutput(credentialIdBytes));
    // The request carried the Level 3 PRF extension input
    // ({ prf: { eval: { first } } }), not the legacy { prf: { first } }
    // input shape.
    const publicKey = seen.getOptions[0].publicKey;
    expect(
      typeof publicKey === "object" &&
        publicKey !== null &&
        "extensions" in publicKey &&
        typeof publicKey.extensions === "object" &&
        publicKey.extensions !== null &&
        "prf" in publicKey.extensions &&
        typeof publicKey.extensions.prf === "object" &&
        publicKey.extensions.prf !== null &&
        "eval" in publicKey.extensions.prf,
    ).toBe(true);
    if (
      typeof publicKey !== "object" ||
      publicKey === null ||
      !("extensions" in publicKey) ||
      typeof publicKey.extensions !== "object" ||
      publicKey.extensions === null ||
      !("prf" in publicKey.extensions) ||
      typeof publicKey.extensions.prf !== "object" ||
      publicKey.extensions.prf === null ||
      !("eval" in publicKey.extensions.prf)
    )
      throw new Error("missing PRF extension input");
    const evalInput = publicKey.extensions.prf.eval;
    if (
      typeof evalInput !== "object" ||
      evalInput === null ||
      !("first" in evalInput) ||
      !(evalInput.first instanceof ArrayBuffer)
    )
      throw new Error("missing PRF extension first input");
    expect(new Uint8Array(evalInput.first)).toEqual(prfInputBytes);
  });

  test("a cancelled passkey prompt is classified as a cancellation", async () => {
    const { platform } = makePlatform({
      assertionResult: "cancel",
      creationResult: "cancel",
    });
    const error = await capture(
      runPasskeyAssertion(platform, credentialIdBytes, prfInputBytes),
    );
    expect(error.code).toBe("cancelled");
  });

  test("an authenticator that cannot evaluate the PRF is reported as unsupported", async () => {
    const { platform } = makePlatform({
      assertionResult: "no-output",
      creationResult: "output",
    });
    const error = await capture(
      runPasskeyAssertion(platform, credentialIdBytes, prfInputBytes),
    );
    expect(error.code).toBe("unsupported");
  });

  test("a credential without a matching passkey is reported distinctly", async () => {
    const { platform } = makePlatform({
      assertionResult: "no-credential",
      creationResult: "output",
    });
    const error = await capture(
      runPasskeyAssertion(platform, credentialIdBytes, prfInputBytes),
    );
    expect(error.code).toBe("no-matching-credential");
  });

  test("passkey creation uses a creation-time result when enabled", async () => {
    const { platform, seen } = makePlatform({
      assertionResult: "output",
      creationResult: "output",
    });
    const created = await createPasskeyWithPrf(
      platform,
      prfInputBytes,
      new Uint8Array(16).fill(1),
    );
    expect(created.credentialId).toEqual(credentialIdBytes);
    expect(created.prfOutput).toEqual(
      await expectedPrfOutput(credentialIdBytes),
    );
    expect(seen.getOptions).toHaveLength(0);
  });

  test("a creation response with enabled true and no result confirms through an assertion", async () => {
    const { platform, seen } = makePlatform({
      assertionResult: "output",
      creationResult: "confirm",
    });
    const created = await createPasskeyWithPrf(
      platform,
      prfInputBytes,
      new Uint8Array(16).fill(1),
    );
    expect(created.prfOutput).toEqual(
      await expectedPrfOutput(credentialIdBytes),
    );
    expect(seen.getOptions).toHaveLength(1);
    expect(seen.deleted).toBe(0);
  });

  test("a creation response with enabled false is discarded without an assertion", async () => {
    const { platform, seen } = makePlatform({
      assertionResult: "output",
      creationResult: "disabled",
    });
    const error = await capture(
      createPasskeyWithPrf(platform, prfInputBytes, new Uint8Array(16).fill(1)),
    );
    expect(error.code).toBe("unsupported");
    expect(seen.getOptions).toHaveLength(0);
    expect(seen.deleted).toBe(1);
  });

  test("a created passkey without PRF support is discarded and reported", async () => {
    const { platform, seen } = makePlatform({
      assertionResult: "no-output",
      creationResult: "confirm",
    });
    const error = await capture(
      createPasskeyWithPrf(platform, prfInputBytes, new Uint8Array(16).fill(1)),
    );
    expect(error.code).toBe("unsupported");
    expect(seen.deleted).toBe(1);
    expect(seen.getOptions).toHaveLength(1);
  });
});

describe("cross-device account key opening", () => {
  // A recovery code exists so a *different* Device can unlock the account:
  // the wrapper's field 10 (deviceId) and 28 (userIdentityGeneration) are the
  // creator Device's identity, bound into the signature and the seal-time AAD.
  // The opener authenticates via the creator's trusted key and must pin only
  // the shared profile/user identity — pinning the creator fields to the
  // opener is the regression that broke device2 recover.
  test("a second Device opens the creator's recovery wrapper via the creator's key", async () => {
    const creator = await generateSigningKeyPair();
    const accountMasterKey = generateAccountMasterKey();
    const recoveryCode = generateRecoveryCode();
    const wrapper = await createAccountKeyWrapper(
      baseInput(creator, accountMasterKey, {
        type: "recoveryCode",
        recoveryCode,
      }),
    );
    // The opener pins only the shared identity fields and trusts the creator's
    // key (as the API reports it via creatorPublicKey).
    const verification = Object.freeze({
      trustedKeys: Object.freeze({
        keys: [await exportSigningPublicKey(creator.publicKey)],
      }),
      context: Object.freeze({
        serverProfileId: uuidToBytes(SERVER_PROFILE_ID),
        userId: USER_ID,
      }),
    });
    const recovered = await unwrapAccountKeyWrapper(
      parseAccountKeyWrapper(encode(wrapper.object)),
      { recoveryCode },
      verification,
    );
    expect(recovered).toEqual(accountMasterKey);
  });

  test("pinning the creator's device identity to the opener fails verification", async () => {
    const creator = await generateSigningKeyPair();
    const opener = await generateSigningKeyPair();
    const accountMasterKey = generateAccountMasterKey();
    const recoveryCode = generateRecoveryCode();
    const wrapper = await createAccountKeyWrapper(
      baseInput(creator, accountMasterKey, {
        type: "recoveryCode",
        recoveryCode,
      }),
    );
    // The buggy shape: the opener pins its own deviceId/generation against
    // fields that carry the creator's identity. The signature still validates
    // (creator key is trusted), but the identity binding must reject.
    const verification = Object.freeze({
      trustedKeys: Object.freeze({
        keys: [
          await exportSigningPublicKey(creator.publicKey),
          await exportSigningPublicKey(opener.publicKey),
        ],
      }),
      context: Object.freeze({
        serverProfileId: uuidToBytes(SERVER_PROFILE_ID),
        userId: USER_ID,
        deviceId: new Uint8Array(16).fill(0x77),
        userIdentityGeneration: 99,
      }),
    });
    await expect(
      unwrapAccountKeyWrapper(
        parseAccountKeyWrapper(encode(wrapper.object)),
        { recoveryCode },
        verification,
      ),
    ).rejects.toThrow("binding mismatch");
  });
});
