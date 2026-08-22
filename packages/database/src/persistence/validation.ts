export const DOTRELAY_V3_SUITE =
  "dotrelay-e2ee-v3-classical-webcrypto" as const;
export const DOTRELAY_PROTOCOL_FORMAT_VERSION = 3 as const;

export const PERSISTENCE_LIMITS = Object.freeze({
  maxProtocolBytes: 64 * 1024 * 1024,
  maxGrantPlaintextBytes: 4 * 1024,
  maxRecoveryPlaintextBytes: 16 * 1024,
  maxLaneCommitments: 100_000,
});

const LENGTHS = Object.freeze({
  opaqueId: 16,
  digest: 48,
  x25519PublicKey: 32,
  ed25519PublicKey: 32,
});

export class PersistenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceValidationError";
  }
}

const fail = (message: string): never => {
  throw new PersistenceValidationError(message);
};

const MAX_CBOR_DEPTH = 12;
const MAX_CBOR_COLLECTION_ITEMS = 100_000;

type CborCursor = { offset: number };

const readCborByte = (bytes: Uint8Array, cursor: CborCursor): number => {
  const value = bytes[cursor.offset++];
  return value ?? fail("canonical protocol bytes are truncated");
};

const readCborArgument = (
  bytes: Uint8Array,
  cursor: CborCursor,
  additional: number,
): bigint => {
  if (additional < 24) return BigInt(additional);
  const width =
    additional === 24
      ? 1
      : additional === 25
        ? 2
        : additional === 26
          ? 4
          : additional === 27
            ? 8
            : 0;
  if (width === 0 || cursor.offset + width > bytes.length)
    fail("canonical protocol bytes contain an invalid argument");
  let value = 0n;
  for (let index = 0; index < width; index++)
    value = (value << 8n) | BigInt(readCborByte(bytes, cursor));
  const minimum =
    width === 1
      ? 24n
      : width === 2
        ? 256n
        : width === 4
          ? 65_536n
          : 4_294_967_296n;
  if (value < minimum)
    fail("canonical protocol bytes use a non-minimal argument");
  return value;
};

const compareCborKeyBytes = (
  bytes: Uint8Array,
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): number => {
  const leftLength = leftEnd - leftStart;
  const rightLength = rightEnd - rightStart;
  if (leftLength !== rightLength) return leftLength - rightLength;
  for (let index = 0; index < leftLength; index++) {
    const leftByte =
      bytes[leftStart + index] ??
      fail("canonical protocol map key is truncated");
    const rightByte =
      bytes[rightStart + index] ??
      fail("canonical protocol map key is truncated");
    const difference = leftByte - rightByte;
    if (difference !== 0) return difference;
  }
  return 0;
};

const readCanonicalCborValue = (
  bytes: Uint8Array,
  cursor: CborCursor,
  depth: number,
): "map" | "value" => {
  if (depth > MAX_CBOR_DEPTH)
    fail("canonical protocol bytes exceed CBOR depth");
  const initial = readCborByte(bytes, cursor);
  const major = initial >> 5;
  const additional = initial & 0x1f;
  if (major === 0) {
    readCborArgument(bytes, cursor, additional);
    return "value";
  }
  if (major === 1 || major === 6 || additional === 31)
    fail("canonical protocol bytes contain an unsupported CBOR type");
  if (major === 2 || major === 3) {
    const length = readCborArgument(bytes, cursor, additional);
    if (length > BigInt(PERSISTENCE_LIMITS.maxProtocolBytes))
      fail("canonical protocol bytes exceed the persistence limit");
    const end = cursor.offset + Number(length);
    if (end > bytes.length) fail("canonical protocol bytes are truncated");
    if (major === 3) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.slice(cursor.offset, end),
        );
      } catch {
        fail("canonical protocol bytes contain invalid UTF-8");
      }
    }
    cursor.offset = end;
    return "value";
  }
  if (major === 4) {
    const length = readCborArgument(bytes, cursor, additional);
    if (length > BigInt(MAX_CBOR_COLLECTION_ITEMS))
      fail("canonical protocol array is too large");
    for (let index = 0; index < Number(length); index++)
      readCanonicalCborValue(bytes, cursor, depth + 1);
    return "value";
  }
  if (major === 5) {
    const length = readCborArgument(bytes, cursor, additional);
    if (length > BigInt(MAX_CBOR_COLLECTION_ITEMS))
      fail("canonical protocol map is too large");
    let previousStart = -1;
    let previousEnd = -1;
    for (let index = 0; index < Number(length); index++) {
      const keyStart = cursor.offset;
      const keyType = readCanonicalCborValue(bytes, cursor, depth + 1);
      const keyEnd = cursor.offset;
      const keyByte = bytes[keyStart];
      if (keyType !== "value" || keyByte === undefined || keyByte >> 5 !== 0)
        fail("canonical protocol map keys must be unsigned integers");
      if (
        previousStart >= 0 &&
        compareCborKeyBytes(
          bytes,
          previousStart,
          previousEnd,
          keyStart,
          keyEnd,
        ) >= 0
      )
        fail("canonical protocol map keys are not in canonical order");
      previousStart = keyStart;
      previousEnd = keyEnd;
      readCanonicalCborValue(bytes, cursor, depth + 1);
    }
    return "map";
  }
  if (
    major === 7 &&
    (additional === 20 || additional === 21 || additional === 22)
  )
    return "value";
  return fail("canonical protocol bytes contain an unsupported CBOR value");
};

export const validateCanonicalCbor = (value: Uint8Array): void => {
  const bytes = validateProtocolBytes(value, "canonical protocol bytes");
  const cursor: CborCursor = { offset: 0 };
  if (readCanonicalCborValue(bytes, cursor, 0) !== "map")
    fail("canonical protocol object must be a CBOR map");
  if (cursor.offset !== bytes.length)
    fail("canonical protocol bytes contain trailing data");
};

export const copyBytes = (value: Uint8Array, name: string): Uint8Array => {
  if (!(value instanceof Uint8Array)) fail(`${name} must be bytes`);
  return new Uint8Array(value);
};

const requireLength = (
  value: Uint8Array,
  expected: number,
  name: string,
): Uint8Array => {
  if (value.length !== expected)
    fail(`${name} must be exactly ${expected} bytes`);
  return value;
};

export const validateOpaqueId = (value: Uint8Array, name = "opaque id") =>
  requireLength(copyBytes(value, name), LENGTHS.opaqueId, name);

export const validateDigest = (value: Uint8Array, name = "digest") =>
  requireLength(copyBytes(value, name), LENGTHS.digest, name);

export const sha384Digest = async (value: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(
    await crypto.subtle.digest(
      "SHA-384",
      copyBytes(value, "digest input") as Uint8Array<ArrayBuffer>,
    ),
  );

export const validateSha384Digest = async (
  value: Uint8Array,
  digest: Uint8Array,
  name = "digest",
): Promise<Uint8Array> => {
  const checkedDigest = validateDigest(digest, name);
  const expectedDigest = await sha384Digest(value);
  if (
    expectedDigest.length !== checkedDigest.length ||
    !expectedDigest.every((byte, index) => byte === checkedDigest[index])
  )
    fail(`${name} does not match its bytes`);
  return checkedDigest;
};

export const validateProtocolProjection = (input: {
  readonly suite: string;
  readonly formatVersion: number;
  readonly kind: number;
  readonly canonicalBytes: Uint8Array;
  readonly digest: Uint8Array;
}): void => {
  if (input.suite !== DOTRELAY_V3_SUITE)
    fail("protocol object suite is not supported");
  if (input.formatVersion !== DOTRELAY_PROTOCOL_FORMAT_VERSION)
    fail("protocol object format version is not supported");
  if (!Number.isInteger(input.kind) || input.kind < 1 || input.kind > 19)
    fail("protocol object kind is not supported");
  const bytes = copyBytes(input.canonicalBytes, "canonical protocol bytes");
  if (bytes.length === 0 || bytes.length > PERSISTENCE_LIMITS.maxProtocolBytes)
    fail("canonical protocol bytes exceed the persistence limit");
  validateCanonicalCbor(bytes);
  validateDigest(input.digest);
};

export const validatePublicKeys = (input: {
  readonly x25519PublicKey: Uint8Array;
  readonly ed25519PublicKey: Uint8Array;
}): void => {
  requireLength(
    copyBytes(input.x25519PublicKey, "X25519 public key"),
    LENGTHS.x25519PublicKey,
    "X25519 public key",
  );
  requireLength(
    copyBytes(input.ed25519PublicKey, "Ed25519 public key"),
    LENGTHS.ed25519PublicKey,
    "Ed25519 public key",
  );
};

export const validateLaneProjection = (input: {
  readonly scope:
    | "ENVIRONMENT_DEFINITION"
    | "VARIABLE_DEFINITION"
    | "SHARED_VALUE"
    | "USER_DEFINED_VALUE";
  readonly ownerUserId?: string;
  readonly originalProviderUserId?: string;
  readonly projectEpoch: bigint;
  readonly plaintextLength: number;
  readonly ciphertextLength: number;
  readonly ciphertextHash: Uint8Array;
}): void => {
  if (input.projectEpoch <= 0n) fail("project epoch must be positive");
  if (!Number.isInteger(input.plaintextLength) || input.plaintextLength < 0)
    fail("plaintext length must be non-negative");
  if (
    !Number.isInteger(input.ciphertextLength) ||
    input.ciphertextLength <= 16 ||
    input.ciphertextLength > PERSISTENCE_LIMITS.maxProtocolBytes
  )
    fail("ciphertext length is outside the persistence limit");
  validateDigest(input.ciphertextHash, "ciphertext hash");

  if (input.scope === "USER_DEFINED_VALUE") {
    if (!input.ownerUserId || input.originalProviderUserId)
      fail("User-defined Value lanes require only an owner User");
    return;
  }
  if (input.scope === "SHARED_VALUE") {
    if (!input.originalProviderUserId || input.ownerUserId)
      fail("Shared Value lanes require only an original provider");
    return;
  }
  if (input.ownerUserId || input.originalProviderUserId)
    fail("definition lanes cannot carry a User owner or provider");
};

export const validateStagedObject = (input: {
  readonly canonicalBytes: Uint8Array;
  readonly digest: Uint8Array;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}): void => {
  validateProtocolBytes(input.canonicalBytes, "staged canonical bytes");
  validateCanonicalCbor(input.canonicalBytes);
  validateDigest(input.digest);
  if (input.expiresAt <= input.createdAt)
    fail("staged object must expire after creation");
};

export const validateProtocolBytes = (
  value: Uint8Array,
  name = "protocol bytes",
): Uint8Array => {
  const bytes = copyBytes(value, name);
  if (bytes.length === 0 || bytes.length > PERSISTENCE_LIMITS.maxProtocolBytes)
    fail(`${name} exceed the persistence limit`);
  return bytes;
};
