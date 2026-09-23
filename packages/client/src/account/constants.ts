// Leaf module holding the shared account-key protocol constants. Both index.ts
// and verification.ts import from here so that verification.ts (which the open/
// unwrap functions call) does not create an import cycle back through index.ts.

export const ACCOUNT_KEY_WRAPPER_FORMAT_VERSION = 2;
export const ACCOUNT_KEY_WRAPPER_KIND = 20;
export const ACCOUNT_KEY_ENVELOPE_KIND = 21;
export const ACCOUNT_KEY_TRANSFER_KIND = 22;

export const WRAPPER_TYPE = {
  passkeyPrf: 1,
  password: 2,
  recoveryCode: 3,
} as const;
export type WrapperType = (typeof WRAPPER_TYPE)[keyof typeof WRAPPER_TYPE];

// The WebAuthn `prf` extension returns exactly 32 bytes (HMAC-SHA256 over the
// stored PRF input; CTAP/WebAuthn spec). The output is ephemeral key-derivation
// material — never stored or transmitted — so the pin lives here, shared by the
// create/unwrap paths (index.ts) and the PRF extraction helper (webauthn-prf.ts).
export const PASSKEY_PRF_OUTPUT_LENGTH = 32;
export const KDF_ARGON2ID = 1;
export const KEY_ENVELOPE_TYPE = {
  projectEpochKey: 1,
  userValueKey: 2,
} as const;
export type KeyEnvelopeType =
  (typeof KEY_ENVELOPE_TYPE)[keyof typeof KEY_ENVELOPE_TYPE];
