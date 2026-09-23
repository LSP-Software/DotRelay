import {
  createAccountKeyWrapper,
  createPasskeyWithPrf,
  createWrappingKey,
  decodeRecoveryCode,
  encodeRecoveryCode,
  extractPasskeyPrfOutput,
  generateAccountMasterKey,
  generateRecoveryCode,
  PasskeyPrfError,
  type PasswordKdfParameters,
  passkeyPrfSupported,
  runPasskeyAssertion,
  unwrapAccountKeyWrapper,
  unwrapBytes,
  wrapBytes,
  wrappingAssociatedData,
} from "@dotrelay/client";
import {
  exportSigningPublicKey,
  generateSigningKeyPair,
  uuidToBytes,
} from "@dotrelay/contracts";

const pin = Object.freeze({
  // Version-4 UUID: uuidToBytes (used by the verification context) rejects
  // non-v4 UUIDs, so the pin must be a valid v4 identifier.
  serverProfileId: "11111111-1111-4111-8111-111111111111",
  origin: "https://profile.example.test",
});

// Small, in-policy KDF so the browser test runs fast while still exercising the
// real Argon2id worker path. The web app uses DEFAULT_PASSWORD_KDF in
// production; the test deliberately does not.
const FAST_KDF: PasswordKdfParameters = Object.freeze({
  memoryKiB: 8,
  iterations: 1,
  parallelism: 1,
});

const equals = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length &&
  left.every((byte, index) => byte === right[index]);

type BrowserGlobal = typeof globalThis & {
  dotRelayClientAccountKeyRoundTrip: () => Promise<{
    readonly accountMasterKeyLength: number;
    readonly recoveryCodeCharacters: number;
    readonly codeRoundTripMatches: boolean;
    readonly accountMasterKeyMatches: boolean;
  }>;
  dotRelayClientPasskeyPrf: () => Promise<{
    readonly supported: boolean;
    readonly extract32Length: number;
    readonly extract64Rejected: boolean;
    readonly extract16Rejected: boolean;
    readonly missingRejected: boolean;
    readonly unsupportedFalseRejected: boolean;
    readonly assertion32Length: number;
    readonly assertionInputBound: boolean;
    readonly assertionCarriesPrfEvalInput: boolean;
    readonly cancelledCode: string | null;
    readonly noMatchingCode: string | null;
    readonly nullCredentialCode: string | null;
    readonly createFromCreateOutput: boolean;
    readonly createViaConfirmation: boolean;
    readonly createDiscardedCode: string | null;
    readonly createDiscardedDeleted: number;
  }>;
  dotRelayClientPasswordWorkerRoundTrip: () => Promise<{
    readonly matches: boolean;
    readonly usedWorker: boolean;
    readonly ticksDelta: number;
  }>;
  dotRelayClientWrapRoundTrip: () => Promise<{
    readonly plaintextLength: number;
    readonly ciphertextLength: number;
    readonly matches: boolean;
  }>;
};

// Trusted-key + identity verification context for an account key object the
// runner just created with its own signing key, so the open path authorizes it
// against the creator's trusted key.
const selfVerification = async (
  signing: CryptoKeyPair,
  userId: Uint8Array,
  deviceId: Uint8Array,
) =>
  Object.freeze({
    trustedKeys: Object.freeze({
      keys: [await exportSigningPublicKey(signing.publicKey)],
    }),
    context: Object.freeze({
      serverProfileId: uuidToBytes(pin.serverProfileId),
      userId,
      deviceId,
      userIdentityGeneration: 1,
    }),
  });

const dotRelayClientWrapRoundTrip = async () => {
  const runtime = globalThis.crypto;
  if (!runtime?.subtle) throw new TypeError("browser WebCrypto is unavailable");
  const deviceId = runtime.getRandomValues(new Uint8Array(16));
  const key = await createWrappingKey(runtime);
  const plaintext = runtime.getRandomValues(new Uint8Array(32));
  const associatedData = wrappingAssociatedData(pin, deviceId);
  const wrapped = await wrapBytes(key, plaintext, associatedData, runtime);
  const opened = await unwrapBytes(
    key,
    wrapped.iv,
    wrapped.ciphertext,
    associatedData,
    runtime,
  );
  return Object.freeze({
    plaintextLength: plaintext.length,
    ciphertextLength: wrapped.ciphertext.length,
    matches: equals(opened, plaintext),
  });
};

// Runs the production Account Master Key recovery-code path in the browser
// runtime: generate the 256-bit AMK, wrap it behind a RECOVERY_CODE wrapper,
// encode the code the way the user is shown it, and unwrap it from the
// decoded human-readable form. The wrapper module graph pulls the Argon2 KDF
// in, so a broken subpath resolution fails the build rather than silently
// dropping the password-wrapper capability from the browser bundle.
const dotRelayClientAccountKeyRoundTrip = async () => {
  const runtime = globalThis.crypto;
  if (!runtime?.subtle) throw new TypeError("browser WebCrypto is unavailable");
  const signing = await generateSigningKeyPair();
  const accountMasterKey = generateAccountMasterKey();
  const recoveryCode = generateRecoveryCode();
  const shown = encodeRecoveryCode(recoveryCode);
  const decoded = decodeRecoveryCode(shown);
  const userId = runtime.getRandomValues(new Uint8Array(16));
  const deviceId = runtime.getRandomValues(new Uint8Array(16));
  const wrapper = await createAccountKeyWrapper({
    serverProfileId: pin.serverProfileId,
    userId,
    deviceId,
    userIdentityGeneration: 1,
    createdAtMs: Date.now(),
    accountMasterKey,
    signingPrivateKey: signing.privateKey,
    kind: { type: "recoveryCode", recoveryCode: decoded },
  });
  const recovered = await unwrapAccountKeyWrapper(
    wrapper,
    { recoveryCode: decoded },
    await selfVerification(signing, userId, deviceId),
  );
  return Object.freeze({
    accountMasterKeyLength: accountMasterKey.length,
    recoveryCodeCharacters: shown.length,
    codeRoundTripMatches: equals(decoded, recoveryCode),
    accountMasterKeyMatches: equals(recovered, accountMasterKey),
  });
};

// Exercises the WebAuthn PRF account-key path in the real Chromium runtime.
// Chromium exposes the platform surface (so `passkeyPrfSupported()` reports
// true), but Playwright cannot emulate the PRF extension, so the assertion
// and creation ceremonies run against a faithful in-page fake of the real
// `PublicKeyCredential` interface: credentials report their PRF result
// through `getClientExtensionResults()` and the output is credential-bound
// (a digest of the credential id and the requested PRF input), exactly like
// the authenticator's HMAC. This is a browser-interface simulation, not a
// passkey hardware test; the real-device test is recorded as outstanding.
// The output is created in-page so no ArrayBuffer crosses the Playwright
// serialization boundary.
type PasskeyPrfBehavior = Readonly<{
  readonly assertion:
    | "output"
    | "no-output"
    | "cancel"
    | "no-credential"
    | "null";
  readonly creation: "output" | "no-output" | "cancel";
}>;

const makeFakePasskeyPlatform = (
  behavior: PasskeyPrfBehavior,
  credentialId: Uint8Array,
) => {
  const seen = {
    getInputs: [] as Uint8Array[],
    createInputs: [] as Uint8Array[],
    deleted: 0,
  };
  const digestOf = async (...parts: Uint8Array[]) => {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const concat = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      concat.set(part, offset);
      offset += part.length;
    }
    return new Uint8Array(
      await globalThis.crypto.subtle.digest("SHA-256", concat),
    );
  };
  const toBuffer = (bytes: Uint8Array): ArrayBuffer => {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  };
  const requestedPrfInput = (
    options: Readonly<{ readonly publicKey: unknown }>,
  ): Uint8Array | null => {
    const publicKey = options.publicKey;
    if (typeof publicKey !== "object" || publicKey === null) return null;
    const record = publicKey as Record<string, unknown>;
    const extensions = record["extensions"];
    if (typeof extensions !== "object" || extensions === null) return null;
    const prf = (extensions as Record<string, unknown>)["prf"];
    if (typeof prf !== "object" || prf === null) return null;
    const evalInput = (prf as Record<string, unknown>)["eval"];
    if (typeof evalInput !== "object" || evalInput === null) return null;
    const first = (evalInput as Record<string, unknown>)["first"];
    return first instanceof ArrayBuffer ? new Uint8Array(first) : null;
  };
  const makeCredential = (output: Uint8Array | null) => ({
    id: "fake-credential",
    rawId: toBuffer(credentialId),
    type: "public-key",
    getClientExtensionResults: () =>
      Object.freeze(
        output
          ? {
              prf: {
                supported: true,
                results: { first: toBuffer(output) },
              },
            }
          : { prf: { supported: false } },
      ),
  });
  const platform = {
    PublicKeyCredential: {
      isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
    },
    crypto: globalThis.crypto,
    navigator: {
      credentials: {
        get: async (options: Readonly<{ readonly publicKey: unknown }>) => {
          seen.getInputs.push(requestedPrfInput(options) ?? new Uint8Array(0));
          switch (behavior.assertion) {
            case "output":
              return makeCredential(
                await digestOf(
                  credentialId,
                  requestedPrfInput(options) ?? new Uint8Array(0),
                ),
              );
            case "no-output":
              return makeCredential(null);
            case "cancel":
              throw new DOMException("cancelled", "NotAllowedError");
            case "no-credential":
              throw new DOMException(
                "no matching credential",
                "CredentialNotAllowedError",
              );
            default:
              return null;
          }
        },
        create: async (options: Readonly<{ readonly publicKey: unknown }>) => {
          seen.createInputs.push(
            requestedPrfInput(options) ?? new Uint8Array(0),
          );
          if (behavior.creation === "cancel")
            throw new DOMException("cancelled", "NotAllowedError");
          return makeCredential(
            behavior.creation === "output"
              ? await digestOf(
                  credentialId,
                  requestedPrfInput(options) ?? new Uint8Array(0),
                )
              : null,
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

const capturePasskeyCode = async (
  promise: Promise<unknown>,
): Promise<string | null> =>
  promise.then(
    () => {
      throw new Error("expected the ceremony to fail");
    },
    (failure: unknown) =>
      failure instanceof PasskeyPrfError ? failure.code : null,
  );

const dotRelayClientPasskeyPrf = async () => {
  const credentialId = new Uint8Array(32).fill(3);
  const prfInput = new Uint8Array(32).fill(5);
  const otherPrfInput = new Uint8Array(32).fill(7);
  const expectedOutput = async (input: Uint8Array) =>
    new Uint8Array(
      await globalThis.crypto.subtle.digest(
        "SHA-256",
        (() => {
          const concat = new Uint8Array(credentialId.length + input.length);
          concat.set(credentialId);
          concat.set(input, credentialId.length);
          return concat;
        })(),
      ),
    );
  // Real Chromium platform detection: the surface exists in the browser.
  const supported = passkeyPrfSupported();
  // Extraction from the client extension results record (Level 3 shape).
  const ok = extractPasskeyPrfOutput({
    prf: {
      supported: true,
      results: { first: new ArrayBuffer(32) },
    },
  });
  const assertionPlatform = makeFakePasskeyPlatform(
    { assertion: "output", creation: "output" },
    credentialId,
  );
  const assertionOutput = await runPasskeyAssertion(
    assertionPlatform.platform,
    credentialId,
    prfInput,
  );
  const otherInputOutput = await runPasskeyAssertion(
    assertionPlatform.platform,
    credentialId,
    otherPrfInput,
  );
  const cancelledCode = await capturePasskeyCode(
    runPasskeyAssertion(
      makeFakePasskeyPlatform(
        { assertion: "cancel", creation: "cancel" },
        credentialId,
      ).platform,
      credentialId,
      prfInput,
    ),
  );
  const noMatchingCode = await capturePasskeyCode(
    runPasskeyAssertion(
      makeFakePasskeyPlatform(
        { assertion: "no-credential", creation: "output" },
        credentialId,
      ).platform,
      credentialId,
      prfInput,
    ),
  );
  const nullCredentialCode = await capturePasskeyCode(
    runPasskeyAssertion(
      makeFakePasskeyPlatform(
        { assertion: "null", creation: "output" },
        credentialId,
      ).platform,
      credentialId,
      prfInput,
    ),
  );
  // Creation paths: creation-time output, confirmation via a real
  // assertion, and discard of a credential that cannot deliver the PRF.
  const directPlatform = makeFakePasskeyPlatform(
    { assertion: "output", creation: "output" },
    credentialId,
  );
  const directCreated = await createPasskeyWithPrf(
    directPlatform.platform,
    prfInput,
    new Uint8Array(16).fill(1),
  );
  const confirmPlatform = makeFakePasskeyPlatform(
    { assertion: "output", creation: "no-output" },
    credentialId,
  );
  const confirmed = await createPasskeyWithPrf(
    confirmPlatform.platform,
    prfInput,
    new Uint8Array(16).fill(1),
  );
  const discardPlatform = makeFakePasskeyPlatform(
    { assertion: "no-output", creation: "no-output" },
    credentialId,
  );
  const discardedCode = await capturePasskeyCode(
    createPasskeyWithPrf(
      discardPlatform.platform,
      prfInput,
      new Uint8Array(16).fill(1),
    ),
  );
  const seenFirst = assertionPlatform.seen.getInputs[0]?.[0] ?? -1;
  const assertionCarriesPrfEvalInput =
    seenFirst === 5 && assertionPlatform.seen.getInputs[0]?.length === 32;
  return Object.freeze({
    supported,
    extract32Length: ok ? ok.length : -1,
    extract64Rejected:
      extractPasskeyPrfOutput({
        prf: {
          supported: true,
          results: { first: new ArrayBuffer(64) },
        },
      }) === null,
    extract16Rejected:
      extractPasskeyPrfOutput({
        prf: {
          supported: true,
          results: { first: new ArrayBuffer(16) },
        },
      }) === null,
    missingRejected: extractPasskeyPrfOutput({}) === null,
    unsupportedFalseRejected:
      extractPasskeyPrfOutput({ prf: { supported: false } }) === null,
    assertion32Length: assertionOutput.length,
    assertionInputBound:
      (await expectedOutput(prfInput)).every(
        (byte, index) => assertionOutput[index] === byte,
      ) &&
      (await expectedOutput(otherPrfInput)).every(
        (byte, index) => otherInputOutput[index] === byte,
      ),
    assertionCarriesPrfEvalInput,
    cancelledCode,
    noMatchingCode,
    nullCredentialCode,
    createFromCreateOutput:
      directCreated.prfOutput.length === 32 &&
      directPlatform.seen.getInputs.length === 0 &&
      directPlatform.seen.deleted === 0,
    createViaConfirmation:
      confirmed.prfOutput.length === 32 && confirmPlatform.seen.deleted === 0,
    createDiscardedCode: discardedCode,
    createDiscardedDeleted: discardPlatform.seen.deleted,
  });
};

// Runs a PASSWORD account-key wrapper round trip in the browser. When the host
// has set `globalThis.__DOTRELAY_ARGON2_WORKER_SOURCE__`, both the create and
// unwrap KDFs execute in a Worker off the main thread; otherwise noble runs on
// the main thread. The runner reads the main-thread responsiveness counter
// (maintained by a setInterval the test installs before the call) before and
// after the round trip so the test can assert the event loop stayed alive
// through the off-thread KDF window.
const dotRelayClientPasswordWorkerRoundTrip = async () => {
  const runtime = globalThis.crypto;
  if (!runtime?.subtle) throw new TypeError("browser WebCrypto is unavailable");
  const global = globalThis as BrowserGlobal & {
    __DOTRELAY_ARGON2_WORKER_SOURCE__?: string;
    __dotrelayTicks?: number;
  };
  const usedWorker =
    typeof global.__DOTRELAY_ARGON2_WORKER_SOURCE__ === "string";
  const ticksBefore = global.__dotrelayTicks ?? 0;
  const signing = await generateSigningKeyPair();
  const accountMasterKey = generateAccountMasterKey();
  const password = new TextEncoder().encode("browser worker kdf probe");
  const userId = runtime.getRandomValues(new Uint8Array(16));
  const deviceId = runtime.getRandomValues(new Uint8Array(16));
  const wrapper = await createAccountKeyWrapper({
    serverProfileId: pin.serverProfileId,
    userId,
    deviceId,
    userIdentityGeneration: 1,
    createdAtMs: Date.now(),
    accountMasterKey,
    signingPrivateKey: signing.privateKey,
    kind: { type: "password", password, kdf: FAST_KDF },
  });
  const recovered = await unwrapAccountKeyWrapper(
    wrapper,
    { password },
    await selfVerification(signing, userId, deviceId),
  );
  const ticksAfter = global.__dotrelayTicks ?? 0;
  return Object.freeze({
    matches: equals(recovered, accountMasterKey),
    usedWorker,
    ticksDelta: ticksAfter - ticksBefore,
  });
};

(globalThis as BrowserGlobal).dotRelayClientWrapRoundTrip =
  dotRelayClientWrapRoundTrip;
(globalThis as BrowserGlobal).dotRelayClientAccountKeyRoundTrip =
  dotRelayClientAccountKeyRoundTrip;
(globalThis as BrowserGlobal).dotRelayClientPasskeyPrf =
  dotRelayClientPasskeyPrf;
(globalThis as BrowserGlobal).dotRelayClientPasswordWorkerRoundTrip =
  dotRelayClientPasswordWorkerRoundTrip;

export {
  dotRelayClientAccountKeyRoundTrip,
  dotRelayClientPasskeyPrf,
  dotRelayClientPasswordWorkerRoundTrip,
  dotRelayClientWrapRoundTrip,
};
