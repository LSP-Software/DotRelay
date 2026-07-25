import {
  CBOR_LIMITS,
  type CborValue,
  canonicalDecode,
  canonicalEncode,
} from "./cbor";
import { contractError } from "./errors";
import {
  FIELD_REGISTRY,
  OBJECT_REGISTRY,
  type ProtocolObject,
  SUITE_VALUE,
} from "./registry";

const UINT64_MAX = (1n << 64n) - 1n;
const SIGNED_FIELDS = new Set([3, 4, 5, 6, 7]);

const mapValue = (
  object: ProtocolObject,
  field: number,
): CborValue | undefined => {
  return object.get(field);
};

const isBytes = (value: CborValue | undefined): value is Uint8Array => {
  return value instanceof Uint8Array;
};

const bigintValue = (value: CborValue | undefined): bigint | undefined => {
  if (typeof value === "bigint" && value >= 0n && value <= UINT64_MAX)
    return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  return undefined;
};

const isUint = (value: CborValue | undefined): value is number | bigint => {
  return bigintValue(value) !== undefined;
};

const numberValue = (value: CborValue | undefined): number | undefined => {
  if (!isUint(value)) return undefined;
  if (typeof value === "bigint")
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
  return value;
};

const isCborStructure = (value: CborValue): boolean => {
  if (typeof value === "string" || value === null || typeof value === "boolean")
    return false;
  if (
    value instanceof Uint8Array ||
    typeof value === "number" ||
    typeof value === "bigint"
  )
    return true;
  if (Array.isArray(value)) return value.every(isCborStructure);
  if (value instanceof Map)
    return [...value.entries()].every(
      ([key, item]) =>
        Number.isSafeInteger(key) &&
        key >= 0 &&
        FIELD_REGISTRY[key] !== undefined &&
        key !== 49 &&
        isCborStructure(item),
    );
  return false;
};

const requireBytes = (
  object: ProtocolObject,
  field: number,
  exactLength?: number,
): Uint8Array => {
  const value = mapValue(object, field);
  if (!isBytes(value)) contractError("invalid_crypto_object");
  if (exactLength !== undefined && value.length !== exactLength)
    contractError("invalid_crypto_object");
  return value;
};

const validateValueType = (field: number, value: CborValue): void => {
  const definition = FIELD_REGISTRY[field];
  if (!definition || !isCborStructure(value))
    contractError("invalid_crypto_object");
  if (definition.type === "uint" && !isUint(value))
    contractError("invalid_crypto_object");
  if (definition.type === "bytes" && !isBytes(value))
    contractError("invalid_crypto_object");
  if (definition.type === "array" && !Array.isArray(value))
    contractError("invalid_crypto_object");
  if (definition.type === "map" && !(value instanceof Map))
    contractError("invalid_crypto_object");
  if (isBytes(value)) {
    if (
      definition.exactLength !== undefined &&
      value.length !== definition.exactLength
    )
      contractError("invalid_crypto_object");
    if (
      definition.maxLength !== undefined &&
      value.length > definition.maxLength
    )
      contractError("payload_too_large");
  }
};

const validateEnum = (value: number | undefined, maximum: number): void => {
  if (value === undefined || value < 1 || value > maximum)
    contractError("invalid_crypto_object");
};

const validateEnumSet = (
  value: number | undefined,
  allowed: readonly number[],
): void => {
  if (value === undefined || !allowed.includes(value))
    contractError("invalid_crypto_object");
};

const validateSignedEnvelope = (object: ProtocolObject, kind: number): void => {
  const definition = OBJECT_REGISTRY[kind];
  if (!definition?.serverVisible) return;
  for (const field of [3, 4, 5]) {
    const fieldDefinition = FIELD_REGISTRY[field];
    if (!fieldDefinition) contractError("invalid_crypto_object");
    requireBytes(
      object,
      field,
      fieldDefinition.maxLength === undefined
        ? fieldDefinition.exactLength
        : undefined,
    );
  }
  const unsignedBody = new Map(
    [...object.entries()].filter(([field]) => !SIGNED_FIELDS.has(field)),
  );
  const expected = canonicalEncode(unsignedBody);
  if (!sameBytes(expected, requireBytes(object, 3)))
    contractError("invalid_crypto_object");
  const hasSuccessorMlDsa = object.has(6);
  const hasSuccessorEd25519 = object.has(7);
  if (
    hasSuccessorMlDsa !== hasSuccessorEd25519 ||
    (kind !== 3 && (hasSuccessorMlDsa || hasSuccessorEd25519))
  )
    contractError("invalid_crypto_object");
  if (kind === 3) {
    requireBytes(object, 6, 3309);
    requireBytes(object, 7, 64);
  }
};

const validateConditionalValues = (
  object: ProtocolObject,
  kind: number,
): void => {
  const fields = new Set(object.keys());
  if (kind === 16) {
    const mutation = numberValue(mapValue(object, 35));
    if (mutation === undefined) contractError("invalid_crypto_object");
    validateEnum(mutation, 5);
    const hasRollbackTarget = fields.has(21);
    const hasRollbackLanes = fields.has(68);
    if (mutation === 3 && (!hasRollbackTarget || !hasRollbackLanes))
      contractError("invalid_crypto_object");
    if (mutation !== 3 && (hasRollbackTarget || hasRollbackLanes))
      contractError("invalid_crypto_object");
  }
  const lane = numberValue(mapValue(object, 36));
  if (lane !== undefined) validateEnum(lane, 4);
  const keyKind = numberValue(mapValue(object, 37));
  if (keyKind !== undefined) validateEnum(keyKind, 3);
  const grantKind = numberValue(mapValue(object, 70));
  if (grantKind !== undefined) validateEnum(grantKind, 7);
  if (kind === 7) {
    validateEnumSet(grantKind, [1, 2, 5]);
    validateEnumSet(keyKind, grantKind === 5 ? [3] : [1]);
  }
  if (kind === 8) {
    validateEnumSet(grantKind, [3, 4, 7]);
    validateEnumSet(keyKind, [2]);
  }
  if (kind === 9) {
    validateEnumSet(grantKind, [6, 7]);
    validateEnumSet(keyKind, grantKind === 6 ? [1] : [2]);
  }
  const role = numberValue(mapValue(object, 78));
  if (role !== undefined) validateEnum(role, 3);
  const lifecycle = numberValue(mapValue(object, 79));
  if (lifecycle !== undefined) validateEnum(lifecycle, 6);
  const plaintextLength = bigintValue(mapValue(object, 71));
  if (plaintextLength !== undefined && plaintextLength > BigInt(1024 * 1024))
    contractError("payload_too_large");
  const ciphertextLength = bigintValue(mapValue(object, 72));
  if (
    ciphertextLength !== undefined &&
    ciphertextLength > BigInt(CBOR_LIMITS.maxObjectBytes)
  )
    contractError("payload_too_large");
  const ciphertext = mapValue(object, 47);
  if (
    ciphertext instanceof Uint8Array &&
    ciphertextLength !== undefined &&
    BigInt(ciphertext.length) !== ciphertextLength
  )
    contractError("invalid_crypto_object");
  if (
    plaintextLength !== undefined &&
    ciphertextLength !== undefined &&
    ciphertextLength !== plaintextLength + 16n
  )
    contractError("invalid_crypto_object");
  for (const field of [53, 54, 68]) {
    const value = mapValue(object, field);
    if (
      Array.isArray(value) &&
      value.length > CBOR_LIMITS.maxManifestLaneCommitments
    )
      contractError("payload_too_large");
  }
  if (
    [7, 8, 9].includes(kind) &&
    plaintextLength !== undefined &&
    plaintextLength > CBOR_LIMITS.maxGrantPlaintextBytes
  )
    contractError("payload_too_large");
  if (
    kind === 10 &&
    plaintextLength !== undefined &&
    plaintextLength > CBOR_LIMITS.maxRecoveryPlaintextBytes
  )
    contractError("payload_too_large");
};

export const validateManifestCeilings = (
  counts: Readonly<{ variables: number; laneCommitments: number }>,
): void => {
  if (
    !Number.isSafeInteger(counts.variables) ||
    counts.variables < 0 ||
    counts.variables > CBOR_LIMITS.maxManifestVariables
  )
    contractError("payload_too_large");
  if (
    !Number.isSafeInteger(counts.laneCommitments) ||
    counts.laneCommitments < 0 ||
    counts.laneCommitments > CBOR_LIMITS.maxManifestLaneCommitments
  )
    contractError("payload_too_large");
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
};

export const protocolObjectFromFields = (
  kind: number,
  fields: ReadonlyMap<number, CborValue>,
): ProtocolObject => {
  const object = new Map<number, CborValue>([
    [0, SUITE_VALUE],
    [1, kind],
    [2, 1],
  ]);
  for (const [field, value] of fields) {
    if (field === 0 || field === 1 || field === 2)
      contractError("invalid_crypto_object");
    object.set(field, value);
  }
  return object;
};

export const validateProtocolObject = (object: ProtocolObject): void => {
  if (!(object instanceof Map)) contractError("invalid_crypto_object");
  const suite = numberValue(mapValue(object, 0));
  if (suite !== SUITE_VALUE) contractError("unsupported_crypto_suite");
  const kind = numberValue(mapValue(object, 1));
  if (kind === undefined || !OBJECT_REGISTRY[kind])
    contractError("invalid_crypto_object");
  if (numberValue(mapValue(object, 2)) !== 1)
    contractError("invalid_crypto_object");
  const definition = kind === undefined ? undefined : OBJECT_REGISTRY[kind];
  if (!definition) contractError("invalid_crypto_object");
  for (const [field, value] of object) {
    const fieldDefinition = FIELD_REGISTRY[field];
    if (
      !fieldDefinition ||
      field === 49 ||
      !definition.allowedFields.includes(field)
    )
      contractError("invalid_crypto_object");
    validateValueType(field, value);
    if (field >= 80 && field <= 83 && definition.serverVisible)
      contractError("invalid_crypto_object");
  }
  for (const field of definition.requiredFields) {
    if (!object.has(field)) contractError("invalid_crypto_object");
  }
  validateSignedEnvelope(object, kind);
  validateConditionalValues(object, kind);
};

export const encodeProtocolObject = (object: ProtocolObject): Uint8Array => {
  validateProtocolObject(object);
  return canonicalEncode(object);
};

export const parseProtocolObject = (bytes: Uint8Array): ProtocolObject => {
  if (!(bytes instanceof Uint8Array)) contractError("invalid_crypto_object");
  if (bytes.length > CBOR_LIMITS.maxObjectBytes)
    contractError("payload_too_large");
  const decoded = canonicalDecode(bytes);
  if (!(decoded instanceof Map)) contractError("invalid_crypto_object");
  validateProtocolObject(decoded);
  return decoded;
};

export const unsignedBodyBytes = (object: ProtocolObject): Uint8Array => {
  validateProtocolObject(object);
  return canonicalEncode(
    new Map(
      [...object.entries()].filter(([field]) => !SIGNED_FIELDS.has(field)),
    ),
  );
};

export const signatureInput = (object: ProtocolObject): Uint8Array => {
  const prefix = new TextEncoder().encode(
    "DotRelay\0dotrelay-e2ee-v2\0Signature\0v1\0",
  );
  const body = unsignedBodyBytes(object);
  const output = new Uint8Array(prefix.length + body.length);
  output.set(prefix);
  output.set(body, prefix.length);
  return output;
};
