import { contractError } from "./errors";
import { utf8Decode, utf8Encode } from "./runtime";

export const CBOR_LIMITS = Object.freeze({
  maxDepth: 12,
  maxCollectionItems: 100_000,
  maxObjectBytes: 64 * 1024 * 1024,
  maxAdminBodyBytes: 256 * 1024,
  maxStagingObjects: 256,
  maxStagingBytes: 16 * 1024 * 1024,
  maxSyncObjects: 256,
  maxSyncBytes: 16 * 1024 * 1024,
  maxGrantPlaintextBytes: 4 * 1024,
  maxRecoveryPlaintextBytes: 16 * 1024,
  maxManifestVariables: 10_000,
  maxManifestLaneCommitments: 100_000,
});

export type CborValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | readonly CborValue[]
  | ReadonlyMap<number, CborValue>;

type Decoder = {
  readonly bytes: Uint8Array;
  offset: number;
};

const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

const asUint = (value: number | bigint): bigint => {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0)
      contractError("invalid_crypto_object");
    return BigInt(value);
  }
  if (value < 0n || value > MAX_UINT64) contractError("invalid_crypto_object");
  return value;
};

const uintBytes = (value: bigint): Uint8Array => {
  if (value < 24n) return Uint8Array.of(Number(value));
  if (value <= 0xffn) return Uint8Array.of(0x18, Number(value));
  if (value <= 0xffffn)
    return Uint8Array.of(0x19, Number(value >> 8n), Number(value & 0xffn));
  if (value <= 0xffffffffn) {
    return Uint8Array.of(
      0x1a,
      Number(value >> 24n),
      Number(value >> 16n) & 0xff,
      Number(value >> 8n) & 0xff,
      Number(value) & 0xff,
    );
  }
  return Uint8Array.of(
    0x1b,
    Number(value >> 56n) & 0xff,
    Number(value >> 48n) & 0xff,
    Number(value >> 40n) & 0xff,
    Number(value >> 32n) & 0xff,
    Number(value >> 24n) & 0xff,
    Number(value >> 16n) & 0xff,
    Number(value >> 8n) & 0xff,
    Number(value) & 0xff,
  );
};

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const length = parts.reduce((total, part) => total + part.length, 0);
  if (length > CBOR_LIMITS.maxObjectBytes) contractError("payload_too_large");
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

const encodeLength = (major: number, length: number): Uint8Array => {
  if (!Number.isSafeInteger(length) || length < 0)
    contractError("invalid_crypto_object");
  return uintBytes(BigInt(length)).map((byte, index) =>
    index === 0 ? byte | (major << 5) : byte,
  );
};

const encodeValue = (value: CborValue, depth: number): Uint8Array => {
  if (depth > CBOR_LIMITS.maxDepth) contractError("invalid_crypto_object");
  if (value === null) return Uint8Array.of(0xf6);
  if (typeof value === "boolean") return Uint8Array.of(value ? 0xf5 : 0xf4);
  if (typeof value === "number" || typeof value === "bigint")
    return uintBytes(asUint(value));
  if (typeof value === "string") {
    const bytes = utf8Encode(value);
    return concat([encodeLength(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array)
    return concat([encodeLength(2, value.length), value]);
  if (Array.isArray(value)) {
    if (value.length > CBOR_LIMITS.maxCollectionItems)
      contractError("payload_too_large");
    return concat([
      encodeLength(4, value.length),
      ...value.map((item) => encodeValue(item, depth + 1)),
    ]);
  }
  if (value instanceof Map) {
    if (value.size > CBOR_LIMITS.maxCollectionItems)
      contractError("payload_too_large");
    const entries = [...value.entries()].map(([key, item]) => {
      if (!Number.isSafeInteger(key) || key < 0)
        contractError("invalid_crypto_object");
      return {
        key: encodeValue(key, depth + 1),
        item: encodeValue(item, depth + 1),
      };
    });
    entries.sort((left, right) => {
      if (left.key.length !== right.key.length)
        return left.key.length - right.key.length;
      for (let index = 0; index < left.key.length; index++) {
        const leftByte = left.key[index];
        const rightByte = right.key[index];
        if (leftByte === undefined || rightByte === undefined)
          contractError("invalid_crypto_object");
        const difference = leftByte - rightByte;
        if (difference !== 0) return difference;
      }
      return 0;
    });
    for (let index = 1; index < entries.length; index++) {
      const previous = entries[index - 1];
      const current = entries[index];
      if (!previous || !current) contractError("invalid_crypto_object");
      if (sameBytes(previous.key, current.key))
        contractError("invalid_crypto_object");
    }
    return concat([
      encodeLength(5, entries.length),
      ...entries.flatMap(({ key, item }) => [key, item]),
    ]);
  }
  contractError("invalid_crypto_object");
};

export const canonicalEncode = (value: CborValue): Uint8Array => {
  return encodeValue(value, 0);
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
};

const readByte = (decoder: Decoder): number => {
  const byte = decoder.bytes[decoder.offset++];
  if (byte === undefined) contractError("invalid_crypto_object");
  return byte;
};

const readLength = (
  decoder: Decoder,
  additional: number,
  collection = false,
): number => {
  const { value } = readAdditionalUInt(decoder, additional);
  const maximum = BigInt(
    collection ? CBOR_LIMITS.maxCollectionItems : CBOR_LIMITS.maxObjectBytes,
  );
  if (value > maximum) contractError("payload_too_large");
  return Number(value);
};

const decodeValue = (decoder: Decoder, depth: number): CborValue => {
  if (depth > CBOR_LIMITS.maxDepth) contractError("invalid_crypto_object");
  const initial = readByte(decoder);
  const major = initial >> 5;
  const additional = initial & 0x1f;
  if (major === 0) {
    const value = readUnsigned(decoder, additional);
    return value <= MAX_SAFE_BIGINT ? Number(value) : value;
  }
  if (major === 1 || major === 6) contractError("invalid_crypto_object");
  if (major === 2 || major === 3) {
    const length = readLength(decoder, additional);
    const end = decoder.offset + length;
    if (end > decoder.bytes.length) contractError("invalid_crypto_object");
    const bytes = decoder.bytes.slice(decoder.offset, end);
    decoder.offset = end;
    if (major === 2) return bytes;
    try {
      return utf8Decode(bytes, "utf-8", { fatal: true });
    } catch {
      contractError("invalid_crypto_object");
    }
  }
  if (major === 4) {
    const length = readLength(decoder, additional, true);
    return Array.from({ length }, () => decodeValue(decoder, depth + 1));
  }
  if (major === 5) {
    const length = readLength(decoder, additional, true);
    const map = new Map<number, CborValue>();
    for (let index = 0; index < length; index++) {
      const key = decodeValue(decoder, depth + 1);
      if (typeof key !== "number" || !Number.isSafeInteger(key) || key < 0)
        contractError("invalid_crypto_object");
      if (map.has(key)) contractError("invalid_crypto_object");
      map.set(key, decodeValue(decoder, depth + 1));
    }
    return map;
  }
  if (major === 7 && additional === 20) return false;
  if (major === 7 && additional === 21) return true;
  if (major === 7 && additional === 22) return null;
  contractError("invalid_crypto_object");
};

const readUnsigned = (decoder: Decoder, additional: number): bigint => {
  return readAdditionalUInt(decoder, additional).value;
};

const readAdditionalUInt = (
  decoder: Decoder,
  additional: number,
): { readonly value: bigint } => {
  if (additional < 24) return { value: BigInt(additional) };
  const count =
    additional === 24
      ? 1
      : additional === 25
        ? 2
        : additional === 26
          ? 4
          : additional === 27
            ? 8
            : 0;
  if (count === 0 || decoder.offset + count > decoder.bytes.length)
    contractError("invalid_crypto_object");
  let value = 0n;
  for (let index = 0; index < count; index++)
    value = (value << 8n) | BigInt(readByte(decoder));
  const minimum =
    count === 1
      ? 24n
      : count === 2
        ? 256n
        : count === 4
          ? 65_536n
          : 4_294_967_296n;
  if (value < minimum || value > MAX_UINT64)
    contractError("invalid_crypto_object");
  return { value };
};

export const canonicalDecode = (bytes: Uint8Array): CborValue => {
  if (!(bytes instanceof Uint8Array)) contractError("invalid_crypto_object");
  if (bytes.length > CBOR_LIMITS.maxObjectBytes)
    contractError("payload_too_large");
  const decoder: Decoder = { bytes, offset: 0 };
  const value = decodeValue(decoder, 0);
  if (decoder.offset !== bytes.length) contractError("invalid_crypto_object");
  if (!sameBytes(canonicalEncode(value), bytes))
    contractError("invalid_crypto_object");
  return value;
};
