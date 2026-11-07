import { sha384, uuidToBytes } from "@dotrelay/contracts";

// The account signing key (ADR 0015) is an Ed25519 key derived from the
// Account Master Key. The AMK never changes, so neither does this key: its
// public key is the User's account identity on one Server Profile.
export const ACCOUNT_SIGNING_KEY_INFO = "dotrelay-account-signing-ed25519-v1";

const PKCS8_ED25519_PREFIX = [
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
];

export type AccountSigningKey = Readonly<{
  readonly privateKey: CryptoKey;
  /** The raw 32-byte Ed25519 public key: the account identity. */
  readonly identity: Uint8Array;
}>;

const publicKeyFromPrivate = async (privateKey: CryptoKey) => {
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  if (!jwk.x) throw new Error("account signing key has no public part");
  return Uint8Array.from(
    atob(jwk.x.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0),
  );
};

export const deriveAccountSigningKey = async (
  accountMasterKey: Uint8Array,
  binding: Readonly<{ serverProfileId: string; userId: string }>,
): Promise<AccountSigningKey> => {
  if (
    !(accountMasterKey instanceof Uint8Array) ||
    accountMasterKey.length !== 32
  )
    throw new TypeError("account master key must be 32 bytes");
  const salt = new Uint8Array(32);
  salt.set(uuidToBytes(binding.serverProfileId));
  salt.set(uuidToBytes(binding.userId), 16);
  const ikm = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(accountMasterKey),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const seed = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-384",
        salt,
        info: new TextEncoder().encode(ACCOUNT_SIGNING_KEY_INFO),
      },
      ikm,
      256,
    ),
  );
  const pkcs8 = new Uint8Array(48);
  pkcs8.set(PKCS8_ED25519_PREFIX);
  pkcs8.set(seed, 16);
  try {
    // Extractable only so the public half can be read back; the private key
    // never leaves this process.
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      "Ed25519",
      true,
      ["sign"],
    );
    return Object.freeze({
      privateKey,
      identity: await publicKeyFromPrivate(privateKey),
    });
  } finally {
    seed.fill(0);
    pkcs8.fill(0);
  }
};

// A short, stable fingerprint for out-of-band comparison: the first 20
// bytes of SHA-384 over the identity, as five groups of eight hex digits.
export const accountFingerprint = async (
  identity: Uint8Array,
): Promise<string> => {
  if (identity.length !== 32)
    throw new TypeError("account identity must be 32 bytes");
  const digest = await sha384(identity);
  const hex = Array.from(digest.slice(0, 20), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return (hex.match(/.{8}/g) ?? []).join(" ");
};
