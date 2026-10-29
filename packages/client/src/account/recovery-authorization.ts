// A separate HKDF purpose keeps this Ed25519 seed independent of wrapper
// encryption. The public key is signed inside the Recovery Code wrapper.
export const recoveryAuthorizationKey = async (
  recoveryCode: Uint8Array,
  salt: Uint8Array,
): Promise<CryptoKey> => {
  if (recoveryCode.length !== 32 || salt.length !== 32)
    throw new Error("invalid recovery material");
  const ikm = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(recoveryCode),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const seed = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-384",
        salt: new Uint8Array(salt),
        info: new TextEncoder().encode(
          "dotrelay-recovery-authorization-ed25519-v1",
        ),
      },
      ikm,
      256,
    ),
  );
  const pkcs8 = new Uint8Array(48);
  pkcs8.set([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22, 0x04, 0x20,
  ]);
  pkcs8.set(seed, 16);
  try {
    return await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", true, [
      "sign",
    ]);
  } finally {
    seed.fill(0);
    pkcs8.fill(0);
  }
};

export const recoveryAuthorizationPublicKey = async (
  privateKey: CryptoKey,
): Promise<Uint8Array> => {
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  if (!jwk.x) throw new Error("missing recovery public key");
  return Uint8Array.from(
    atob(jwk.x.replaceAll("-", "+").replaceAll("_", "/")),
    (ch) => ch.charCodeAt(0),
  );
};
