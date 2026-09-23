import {
  createAccountKeyWrapper,
  createWrappingKey,
  decodeRecoveryCode,
  encodeRecoveryCode,
  extractPasskeyPrfOutput,
  generateAccountMasterKey,
  generateRecoveryCode,
  type PasswordKdfParameters,
  passkeyPrfSupported,
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

// Exercises the WebAuthn `prf` extension result handling in the real Chromium
// runtime: a synthetic PublicKeyAuthenticationResponse-shaped object carrying a
// 32-byte `extensions.prf` ArrayBuffer must yield that output, while 64/16-byte
// and missing-extension results are rejected. The output is created in-page so
// no ArrayBuffer crosses the Playwright serialization boundary.
const dotRelayClientPasskeyPrf = async () => {
  const ok = extractPasskeyPrfOutput({
    extensions: { prf: new ArrayBuffer(32) },
  });
  return Object.freeze({
    supported: passkeyPrfSupported(),
    extract32Length: ok ? ok.length : -1,
    extract64Rejected:
      extractPasskeyPrfOutput({ extensions: { prf: new ArrayBuffer(64) } }) ===
      null,
    extract16Rejected:
      extractPasskeyPrfOutput({ extensions: { prf: new ArrayBuffer(16) } }) ===
      null,
    missingRejected: extractPasskeyPrfOutput({}) === null,
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
