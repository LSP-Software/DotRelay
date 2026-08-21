import { type CborValue, canonicalDecode, canonicalEncode } from "./cbor";
import { signatureInput } from "./protocol";
import {
  FIELD_REGISTRY,
  FIXED_LENGTHS,
  type ProtocolObject,
  SUITE_NAME,
  SUITE_VALUE,
} from "./registry";

const AES_GCM_TAG_LENGTH = 128;
const X25519_RAW_PUBLIC_KEY_FORMAT = "raw" as const;
const X25519_PUBLIC_KEY_FORMAT = "spki" as const;
const X25519_PRIVATE_KEY_FORMAT = "pkcs8" as const;
const ED25519_PUBLIC_KEY_FORMAT = "spki" as const;
const ED25519_PRIVATE_KEY_FORMAT = "pkcs8" as const;

const ENVELOPE_FIELDS = Object.freeze([0, 44, 45, 46, 47, 48, 71, 72]);
const KEY_DERIVATION_INFO = new TextEncoder().encode(
  `DotRelay\0${SUITE_NAME}\0AES-256-GCM\0v1`,
);

export const CRYPTO_SUITE = Object.freeze({
  name: SUITE_NAME,
  version: SUITE_VALUE,
  mediaType: "application/vnd.dotrelay.e2ee-v3+cbor",
  claim: "classical cryptography only; no post-quantum resistance",
  algorithms: Object.freeze({
    keyAgreement: "X25519",
    signature: "Ed25519",
    keyDerivation: "HKDF-SHA-384",
    encryption: "AES-256-GCM",
    digest: "SHA-384",
  }),
});

export type ClassicalEncryptionKeyPair = CryptoKeyPair;
export type ClassicalSigningKeyPair = CryptoKeyPair;
export type CiphertextEnvelope = ReadonlyMap<number, CborValue>;

export class InvalidCiphertextError extends Error {
  constructor() {
    super("Invalid ciphertext envelope");
    this.name = "InvalidCiphertextError";
  }
}

const asBufferSource = (input: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  return copy.buffer;
};

const bytes = (value: ArrayBuffer): Uint8Array => new Uint8Array(value);

const randomBytes = (length: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(length));

const requireKey = (
  key: CryptoKey,
  algorithm: string,
  type: "public" | "private" | "secret",
): void => {
  if (key.algorithm.name !== algorithm || key.type !== type)
    throw new TypeError(`Expected ${type} ${algorithm} key`);
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
};

const readBytes = (
  envelope: CiphertextEnvelope,
  field: number,
  length?: number,
): Uint8Array => {
  const value = envelope.get(field);
  if (!(value instanceof Uint8Array)) throw new InvalidCiphertextError();
  if (length !== undefined && value.length !== length)
    throw new InvalidCiphertextError();
  return value;
};

const readLength = (envelope: CiphertextEnvelope, field: number): number => {
  const value = envelope.get(field);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new InvalidCiphertextError();
  return value;
};

const validateEnvelope = (envelope: CiphertextEnvelope): void => {
  if (!(envelope instanceof Map)) throw new InvalidCiphertextError();
  if (
    envelope.size !== ENVELOPE_FIELDS.length ||
    ENVELOPE_FIELDS.some((field) => !envelope.has(field))
  )
    throw new InvalidCiphertextError();
  for (const [field, value] of envelope) {
    if (!FIELD_REGISTRY[field] || !ENVELOPE_FIELDS.includes(field))
      throw new InvalidCiphertextError();
    if (!(value instanceof Uint8Array) && typeof value !== "number")
      throw new InvalidCiphertextError();
  }
  const suite = envelope.get(0);
  if (suite !== SUITE_VALUE) throw new InvalidCiphertextError();
  readBytes(envelope, 44, FIXED_LENGTHS.hkdfSalt);
  readBytes(envelope, 45, FIXED_LENGTHS.x25519);
  readBytes(envelope, 46, FIXED_LENGTHS.iv);
  const ciphertext = readBytes(envelope, 47);
  readBytes(envelope, 48, FIXED_LENGTHS.digest);
  const plaintextLength = readLength(envelope, 71);
  const ciphertextLength = readLength(envelope, 72);
  if (
    ciphertext.length !== ciphertextLength ||
    ciphertextLength !== plaintextLength + FIXED_LENGTHS.tag
  )
    throw new InvalidCiphertextError();
};

const parseEnvelope = (encoded: Uint8Array): CiphertextEnvelope => {
  try {
    if (!(encoded instanceof Uint8Array)) throw new InvalidCiphertextError();
    const decoded = canonicalDecode(encoded);
    if (!(decoded instanceof Map)) throw new InvalidCiphertextError();
    if (!sameBytes(canonicalEncode(decoded), encoded))
      throw new InvalidCiphertextError();
    validateEnvelope(decoded);
    return decoded;
  } catch {
    throw new InvalidCiphertextError();
  }
};

const deriveAesKey = async (
  sharedSecret: Uint8Array,
  salt: Uint8Array,
): Promise<CryptoKey> => {
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    asBufferSource(sharedSecret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-384",
      salt: asBufferSource(salt),
      info: asBufferSource(KEY_DERIVATION_INFO),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
};

export const generateEncryptionKeyPair = async (): Promise<CryptoKeyPair> =>
  (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as unknown as CryptoKeyPair;

export const generateSigningKeyPair = async (): Promise<CryptoKeyPair> =>
  (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;

export const exportEncryptionPublicKey = async (
  key: CryptoKey,
): Promise<Uint8Array> => {
  requireKey(key, "X25519", "public");
  return bytes(await crypto.subtle.exportKey(X25519_PUBLIC_KEY_FORMAT, key));
};

export const exportEncryptionPrivateKey = async (
  key: CryptoKey,
): Promise<Uint8Array> => {
  requireKey(key, "X25519", "private");
  return bytes(await crypto.subtle.exportKey(X25519_PRIVATE_KEY_FORMAT, key));
};

export const importEncryptionPublicKey = async (
  encoded: Uint8Array,
): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    X25519_PUBLIC_KEY_FORMAT,
    asBufferSource(encoded),
    { name: "X25519" },
    true,
    [],
  );

const importRawEncryptionPublicKey = async (
  encoded: Uint8Array,
): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    X25519_RAW_PUBLIC_KEY_FORMAT,
    asBufferSource(encoded),
    { name: "X25519" },
    false,
    [],
  );

export const importEncryptionPrivateKey = async (
  encoded: Uint8Array,
): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    X25519_PRIVATE_KEY_FORMAT,
    asBufferSource(encoded),
    { name: "X25519" },
    true,
    ["deriveBits"],
  );

export const exportSigningPublicKey = async (
  key: CryptoKey,
): Promise<Uint8Array> => {
  requireKey(key, "Ed25519", "public");
  return bytes(await crypto.subtle.exportKey(ED25519_PUBLIC_KEY_FORMAT, key));
};

export const exportSigningPrivateKey = async (
  key: CryptoKey,
): Promise<Uint8Array> => {
  requireKey(key, "Ed25519", "private");
  return bytes(await crypto.subtle.exportKey(ED25519_PRIVATE_KEY_FORMAT, key));
};

export const importSigningPublicKey = async (
  encoded: Uint8Array,
): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    ED25519_PUBLIC_KEY_FORMAT,
    asBufferSource(encoded),
    { name: "Ed25519" },
    true,
    ["verify"],
  );

export const importSigningPrivateKey = async (
  encoded: Uint8Array,
): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    ED25519_PRIVATE_KEY_FORMAT,
    asBufferSource(encoded),
    { name: "Ed25519" },
    true,
    ["sign"],
  );

export const sha384 = async (value: Uint8Array): Promise<Uint8Array> =>
  bytes(await crypto.subtle.digest("SHA-384", asBufferSource(value)));

export const seal = async (
  plaintext: Uint8Array,
  recipientPublicKey: CryptoKey,
  associatedData: Uint8Array = new Uint8Array(),
): Promise<Uint8Array> => {
  if (!(plaintext instanceof Uint8Array))
    throw new TypeError("plaintext must be bytes");
  requireKey(recipientPublicKey, "X25519", "public");
  const ephemeral = await generateEncryptionKeyPair();
  const salt = randomBytes(FIXED_LENGTHS.hkdfSalt);
  const iv = randomBytes(FIXED_LENGTHS.iv);
  let sharedSecret: Uint8Array | undefined;
  try {
    const ephemeralPublicKey = bytes(
      await crypto.subtle.exportKey(
        X25519_RAW_PUBLIC_KEY_FORMAT,
        ephemeral.publicKey,
      ),
    );
    sharedSecret = bytes(
      await crypto.subtle.deriveBits(
        { name: "X25519", public: recipientPublicKey },
        ephemeral.privateKey,
        256,
      ),
    );
    const aesKey = await deriveAesKey(sharedSecret, salt);
    const ciphertext = bytes(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: asBufferSource(iv),
          additionalData: asBufferSource(associatedData),
          tagLength: AES_GCM_TAG_LENGTH,
        },
        aesKey,
        asBufferSource(plaintext),
      ),
    );
    const envelope = new Map<number, CborValue>([
      [0, SUITE_VALUE],
      [44, salt],
      [45, ephemeralPublicKey],
      [46, iv],
      [47, ciphertext],
      [48, await sha384(ciphertext)],
      [71, plaintext.length],
      [72, ciphertext.length],
    ]);
    validateEnvelope(envelope);
    return canonicalEncode(envelope);
  } finally {
    sharedSecret?.fill(0);
  }
};

export const open = async (
  encodedEnvelope: Uint8Array,
  recipientPrivateKey: CryptoKey,
  expectedAssociatedData: Uint8Array = new Uint8Array(),
): Promise<Uint8Array> => {
  try {
    requireKey(recipientPrivateKey, "X25519", "private");
    const envelope = parseEnvelope(encodedEnvelope);
    const salt = readBytes(envelope, 44, FIXED_LENGTHS.hkdfSalt);
    const ephemeralPublicKey = await importRawEncryptionPublicKey(
      readBytes(envelope, 45, FIXED_LENGTHS.x25519),
    );
    const iv = readBytes(envelope, 46, FIXED_LENGTHS.iv);
    const ciphertext = readBytes(envelope, 47);
    const expectedDigest = await sha384(ciphertext);
    if (
      !sameBytes(expectedDigest, readBytes(envelope, 48, FIXED_LENGTHS.digest))
    )
      throw new InvalidCiphertextError();
    let sharedSecret: Uint8Array | undefined;
    try {
      sharedSecret = bytes(
        await crypto.subtle.deriveBits(
          { name: "X25519", public: ephemeralPublicKey },
          recipientPrivateKey,
          256,
        ),
      );
      const aesKey = await deriveAesKey(sharedSecret, salt);
      return bytes(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: asBufferSource(iv),
            additionalData: asBufferSource(expectedAssociatedData),
            tagLength: AES_GCM_TAG_LENGTH,
          },
          aesKey,
          asBufferSource(ciphertext),
        ),
      );
    } finally {
      sharedSecret?.fill(0);
    }
  } catch {
    throw new InvalidCiphertextError();
  }
};

export const sign = async (
  message: Uint8Array,
  privateKey: CryptoKey,
): Promise<Uint8Array> => {
  requireKey(privateKey, "Ed25519", "private");
  return bytes(
    await crypto.subtle.sign("Ed25519", privateKey, asBufferSource(message)),
  );
};

export const verify = async (
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: CryptoKey,
): Promise<boolean> => {
  try {
    requireKey(publicKey, "Ed25519", "public");
    if (signature.length !== FIXED_LENGTHS.ed25519Signature) return false;
    return await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      asBufferSource(signature),
      asBufferSource(message),
    );
  } catch {
    return false;
  }
};

export const signProtocolObject = async (
  object: ProtocolObject,
  privateKey: CryptoKey,
): Promise<Uint8Array> => sign(signatureInput(object), privateKey);

export const verifyProtocolObject = async (
  object: ProtocolObject,
  signature: Uint8Array,
  publicKey: CryptoKey,
): Promise<boolean> => verify(signatureInput(object), signature, publicKey);

export const encodeCiphertextEnvelope = (
  envelope: CiphertextEnvelope,
): Uint8Array => {
  validateEnvelope(envelope);
  return canonicalEncode(envelope);
};

export const decodeCiphertextEnvelope = (
  encoded: Uint8Array,
): CiphertextEnvelope => parseEnvelope(encoded);
