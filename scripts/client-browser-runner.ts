import {
  createAccountKeyWrapper,
  createWrappingKey,
  decodeRecoveryCode,
  encodeRecoveryCode,
  generateAccountMasterKey,
  generateRecoveryCode,
  unwrapAccountKeyWrapper,
  unwrapBytes,
  wrapBytes,
  wrappingAssociatedData,
} from "@dotrelay/client";
import { generateSigningKeyPair } from "@dotrelay/contracts";

const pin = Object.freeze({
  serverProfileId: "00000000-0000-0000-0000-000000000001",
  origin: "https://profile.example.test",
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
  dotRelayClientWrapRoundTrip: () => Promise<{
    readonly plaintextLength: number;
    readonly ciphertextLength: number;
    readonly matches: boolean;
  }>;
};

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
  const wrapper = await createAccountKeyWrapper({
    serverProfileId: pin.serverProfileId,
    userId: runtime.getRandomValues(new Uint8Array(16)),
    deviceId: runtime.getRandomValues(new Uint8Array(16)),
    userIdentityGeneration: 1,
    createdAtMs: Date.now(),
    accountMasterKey,
    signingPrivateKey: signing.privateKey,
    kind: { type: "recoveryCode", recoveryCode: decoded },
  });
  const recovered = await unwrapAccountKeyWrapper(wrapper, {
    recoveryCode: decoded,
  });
  return Object.freeze({
    accountMasterKeyLength: accountMasterKey.length,
    recoveryCodeCharacters: shown.length,
    codeRoundTripMatches: equals(decoded, recoveryCode),
    accountMasterKeyMatches: equals(recovered, accountMasterKey),
  });
};

(globalThis as BrowserGlobal).dotRelayClientWrapRoundTrip =
  dotRelayClientWrapRoundTrip;
(globalThis as BrowserGlobal).dotRelayClientAccountKeyRoundTrip =
  dotRelayClientAccountKeyRoundTrip;

export { dotRelayClientAccountKeyRoundTrip, dotRelayClientWrapRoundTrip };
