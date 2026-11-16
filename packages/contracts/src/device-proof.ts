import { contractError } from "./errors";
import { parseJsonObject } from "./api";
import { parseUuid, uuidToBytes } from "./protocol-api";

export { DEVICE_PROOF_HEADER } from "./protocol-api";

// Device proof of possession (ADR 0020). A Device signs a challenge from the
// service with its Ed25519 key and exchanges the signature for a short-lived
// token bound to one session and one Device. Every Device-scoped request
// carries the token in DEVICE_PROOF_HEADER.

/** The exact length of a challenge, decoded. */
export const DEVICE_PROOF_CHALLENGE_BYTES = 57;
/** The exact length of a proof token, decoded. */
export const DEVICE_PROOF_TOKEN_BYTES = 73;

const MESSAGE_PREFIX = "dotrelay-device-proof-v1\0";
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** Unpadded base64url, the wire form of challenges and tokens. */
export const encodeDeviceProofValue = (bytes: Uint8Array): string =>
  toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

/**
 * Decodes an unpadded base64url challenge or token of an exact decoded
 * length. Anything else is `invalid_request`.
 */
export const decodeDeviceProofValue = (
  value: unknown,
  length: number,
): Uint8Array => {
  if (
    typeof value !== "string" ||
    value.length !== Math.ceil((length * 4) / 3) ||
    !BASE64URL.test(value)
  )
    contractError("invalid_request");
  let binary: string;
  try {
    binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    contractError("invalid_request");
  }
  if (binary.length !== length) contractError("invalid_request");
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  // Reject non-canonical encodings (set padding bits) so one token has one
  // spelling.
  if (encodeDeviceProofValue(bytes) !== value) contractError("invalid_request");
  return bytes;
};

/**
 * The message a Device signs to exchange `challenge` for a Device proof:
 * a domain prefix, then the Server Profile, User and Device ids as 16 bytes
 * each, then the challenge bytes.
 */
export const deviceProofMessage = (
  input: Readonly<{
    readonly serverProfileId: string;
    readonly userId: string;
    readonly deviceId: string;
    readonly challenge: Uint8Array;
  }>,
): Uint8Array<ArrayBuffer> => {
  if (input.challenge.length !== DEVICE_PROOF_CHALLENGE_BYTES)
    contractError("invalid_request");
  const prefix = new TextEncoder().encode(MESSAGE_PREFIX);
  const parts = [
    prefix,
    uuidToBytes(input.serverProfileId),
    uuidToBytes(input.userId),
    uuidToBytes(input.deviceId),
    input.challenge,
  ];
  const message = new Uint8Array(
    new ArrayBuffer(parts.reduce((total, part) => total + part.length, 0)),
  );
  let offset = 0;
  for (const part of parts) {
    message.set(part, offset);
    offset += part.length;
  }
  return message;
};

const parseLifetime = (value: unknown): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 3600
  )
    contractError("invalid_request");
  return value;
};

export type DeviceProofChallenge = Readonly<{
  readonly challenge: Uint8Array;
  /** Seconds the challenge stays valid, counted from receipt. */
  readonly expiresIn: number;
}>;

/** Parses a `POST /api/v1/devices/proofs/challenges` response. */
export const parseDeviceProofChallenge = (
  value: unknown,
): DeviceProofChallenge => {
  const body = parseJsonObject<{ challenge?: unknown; expiresIn?: unknown }>(
    value,
    ["challenge", "expiresIn"],
  );
  return Object.freeze({
    challenge: decodeDeviceProofValue(
      body.challenge,
      DEVICE_PROOF_CHALLENGE_BYTES,
    ),
    expiresIn: parseLifetime(body.expiresIn),
  });
};

export type DeviceProof = Readonly<{
  /** The header value for DEVICE_PROOF_HEADER. */
  readonly token: string;
  readonly deviceId: string;
  /** Seconds the proof stays valid, counted from receipt. */
  readonly expiresIn: number;
}>;

/** Parses a `POST /api/v1/devices/proofs` response. */
export const parseDeviceProof = (value: unknown): DeviceProof => {
  const body = parseJsonObject<{
    token?: unknown;
    deviceId?: unknown;
    expiresIn?: unknown;
  }>(value, ["token", "deviceId", "expiresIn"]);
  decodeDeviceProofValue(body.token, DEVICE_PROOF_TOKEN_BYTES);
  return Object.freeze({
    token: body.token as string,
    deviceId: parseUuid(body.deviceId, "deviceId"),
    expiresIn: parseLifetime(body.expiresIn),
  });
};

/**
 * The exact command a Device signs to delete its account (ADR 0024), in the
 * form the service records: UTF-8 JSON naming the action, the User and the
 * operation id (the request's Idempotency-Key). Like a Device revocation, a
 * session that holds no Device key cannot produce the signature.
 */
export const accountDeletionCommand = (
  input: Readonly<{ readonly userId: string; readonly operationId: string }>,
): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(
    JSON.stringify({
      action: "account.delete",
      userId: parseUuid(input.userId, "userId"),
      operationId: parseUuid(input.operationId, "operationId"),
    }),
  );
