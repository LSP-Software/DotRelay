import { PASSKEY_PRF_OUTPUT_LENGTH } from "./constants";

// The WebAuthn `prf` extension is the platform mechanism that lets a passkey
// contribute exactly 32 bytes of key material (HMAC-SHA256 over the
// application-provided 32-byte PRF input) without exposing the credential
// secret. The result rides on the assertion response as
// `response.extensions.prf` (an ArrayBuffer). The CTAP/WebAuthn spec fixes that
// output at 32 bytes, so the pin here mirrors the platform guarantee rather
// than an arbitrary choice.
//
// The output is ephemeral key-derivation material: it is never stored or
// transmitted, only fed to HKDF, so its size can change without a wire-format
// change.

// The minimal shape of a WebAuthn assertion response that may carry the PRF
// extension result. Kept structural (not the DOM `PublicKeyAuthenticationResponse`
// type) so the module stays free of browser type dependencies and can be driven
// by a synthetic extension result in tests and by the real result in the browser.
export type PasskeyAuthenticationResponse = Readonly<{
  readonly extensions?: Readonly<{
    readonly prf?: ArrayBuffer;
  }>;
}>;

// Read the PRF extension output from a passkey assertion response and return it
// as a 32-byte Uint8Array. Returns null when the platform returned no PRF output
// (extension unavailable or not requested) or when the output is not exactly 32
// bytes. Callers treat null as "PRF output unavailable" and fall back to the
// password or recovery-code recovery path.
export const extractPasskeyPrfOutput = (
  response: PasskeyAuthenticationResponse,
): Uint8Array | null => {
  const prf = response.extensions?.prf;
  if (prf === undefined) return null;
  const bytes = new Uint8Array(prf);
  if (bytes.length !== PASSKEY_PRF_OUTPUT_LENGTH) return null;
  return bytes;
};

// A platform surface that reports whether the WebAuthn PRF extension is usable.
// In the browser this is `globalThis`; tests pass a narrow fake.
export type PasskeyPrfPlatform = Readonly<{
  readonly PublicKeyCredential?: unknown;
  readonly navigator?: {
    readonly credentials?: {
      readonly get?: unknown;
    };
  };
}>;

// Best-effort platform feature detection for the WebAuthn PRF extension. A
// platform that exposes `PublicKeyCredential` and a `navigator.credentials.get`
// can request the extension during an assertion; whether it actually returns a
// PRF output is confirmed per-assertion via extractPasskeyPrfOutput. Returns
// false when the passkey PRF recovery path is unavailable and the caller should
// offer the password or recovery-code path instead.
export const passkeyPrfSupported = (
  platform: PasskeyPrfPlatform = globalThis as PasskeyPrfPlatform,
): boolean => {
  if (typeof platform.PublicKeyCredential === "undefined") return false;
  if (typeof platform.navigator === "undefined") return false;
  if (typeof platform.navigator.credentials === "undefined") return false;
  if (typeof platform.navigator.credentials.get !== "function") return false;
  return true;
};
