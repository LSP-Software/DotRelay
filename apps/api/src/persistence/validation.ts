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
