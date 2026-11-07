import {
  type ProtocolObject,
  parseProtocolObject,
  verifyProtocolObject,
} from "@dotrelay/contracts";

export class ProtocolVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolVerificationError";
  }
}

const requireField = (
  object: ProtocolObject,
  field: number,
  length?: number,
): Uint8Array => {
  const value = object.get(field);
  if (!(value instanceof Uint8Array))
    throw new ProtocolVerificationError(`field ${field} must be bytes`);
  if (length !== undefined && value.length !== length)
    throw new ProtocolVerificationError(`field ${field} has invalid length`);
  return value;
};

// An Ed25519 public key arrives either raw (32 bytes, boundary / API keys) or
// as SPKI (a locally exported key); both are accepted.
const importVerifyKey = (publicKeyBytes: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    publicKeyBytes.length === 32 ? "raw" : "spki",
    new Uint8Array(publicKeyBytes).buffer,
    { name: "Ed25519" },
    false,
    ["verify"],
  );

export const verifySignedProtocolObject = async (
  bytes: Uint8Array,
  publicKeyBytes: Uint8Array,
): Promise<ProtocolObject> => {
  const object = parseProtocolObject(bytes);
  const signature = requireField(object, 4, 64);
  const publicKey = await importVerifyKey(publicKeyBytes);
  const verified = await verifyProtocolObject(object, signature, publicKey);
  if (!verified)
    throw new ProtocolVerificationError("signature verification failed");
  return object;
};

// True when any trusted Ed25519 public key validates the field-4 signature
// over the canonical unsigned body. A malformed trusted key is skipped so it
// cannot mask a valid one.
export const isSignedByTrustedKey = async (
  object: ProtocolObject,
  trustedKeys: readonly Uint8Array[],
): Promise<boolean> => {
  const signature = object.get(4);
  if (!(signature instanceof Uint8Array) || signature.length !== 64)
    return false;
  for (const keyBytes of trustedKeys) {
    try {
      const publicKey = await importVerifyKey(keyBytes);
      if (await verifyProtocolObject(object, signature, publicKey)) return true;
    } catch {
      // A malformed trusted key must not mask a valid one.
    }
  }
  return false;
};
