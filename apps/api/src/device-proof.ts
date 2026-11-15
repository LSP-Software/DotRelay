import {
  bytesToUuid,
  DEVICE_PROOF_CHALLENGE_BYTES,
  DEVICE_PROOF_TOKEN_BYTES,
  decodeDeviceProofValue,
  encodeDeviceProofValue,
  uuidToBytes,
} from "@dotrelay/contracts";

// Challenges and tokens for Device proof of possession (ADR 0018). Both are
// stateless: an HMAC-SHA-256 tag under a key derived from the Server
// Profile's auth secret binds them to the session that asked, so every API
// replica can check them and nothing is stored per proof.

export const DEVICE_PROOF_CHALLENGE_TTL_MS = 120_000;
export const DEVICE_PROOF_TTL_MS = 300_000;
// Tolerates replicas whose clocks disagree by a little.
const ISSUED_IN_FUTURE_TOLERANCE_MS = 30_000;

const VERSION = 1;
const NONCE_BYTES = 16;
const encoder = new TextEncoder();
const CHALLENGE_LABEL = encoder.encode("dotrelay-device-proof-challenge-v1\0");
const TOKEN_LABEL = encoder.encode("dotrelay-device-proof-token-v1\0");

type ProofSecret = Readonly<{
  readonly id: string;
  readonly authSecret: string;
}>;

const keys = new WeakMap<ProofSecret, Promise<CryptoKey>>();

const macKey = (profile: ProofSecret): Promise<CryptoKey> => {
  const cached = keys.get(profile);
  if (cached) return cached;
  const derived = (async () => {
    const material = await crypto.subtle.importKey(
      "raw",
      encoder.encode(profile.authSecret),
      "HKDF",
      false,
      ["deriveKey"],
    );
    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: uuidToBytes(profile.id).slice(),
        info: encoder.encode("dotrelay-device-proof-v1"),
      },
      material,
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign", "verify"],
    );
  })();
  keys.set(profile, derived);
  return derived;
};

const concat = (...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const output = new Uint8Array(
    new ArrayBuffer(parts.reduce((total, part) => total + part.length, 0)),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

const u64 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
};

const lengthPrefixed = (bytes: Uint8Array): Uint8Array => {
  const length = new Uint8Array(2);
  new DataView(length.buffer).setUint16(0, bytes.length);
  return concat(length, bytes);
};

const readU64 = (bytes: Uint8Array, offset: number): number =>
  Number(
    new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0),
  );

const tag = async (
  profile: ProofSecret,
  data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.sign("HMAC", await macKey(profile), data));

const tagMatches = async (
  profile: ProofSecret,
  data: Uint8Array<ArrayBuffer>,
  candidate: Uint8Array,
): Promise<boolean> =>
  crypto.subtle.verify("HMAC", await macKey(profile), candidate.slice(), data);

const challengeData = (
  nonce: Uint8Array,
  issuedAtMs: number,
  sessionId: string,
) => concat(CHALLENGE_LABEL, nonce, u64(issuedAtMs), encoder.encode(sessionId));

const tokenData = (
  input: Readonly<{
    readonly deviceId: Uint8Array;
    readonly expiresAtMs: number;
    readonly nonce: Uint8Array;
    readonly userId: string;
    readonly sessionId: string;
  }>,
) =>
  concat(
    TOKEN_LABEL,
    input.deviceId,
    u64(input.expiresAtMs),
    input.nonce,
    lengthPrefixed(encoder.encode(input.userId)),
    encoder.encode(input.sessionId),
  );

/** A challenge for `sessionId`, in its wire form. */
export const issueDeviceProofChallenge = async (
  profile: ProofSecret,
  sessionId: string,
  nowMs: number,
): Promise<string> => {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  return encodeDeviceProofValue(
    concat(
      Uint8Array.of(VERSION),
      nonce,
      u64(nowMs),
      await tag(profile, challengeData(nonce, nowMs, sessionId)),
    ),
  );
};

export type VerifiedChallenge = Readonly<{
  readonly nonce: Uint8Array;
  readonly issuedAtMs: number;
}>;

/**
 * The challenge's nonce and issue time when `challenge` was issued to
 * `sessionId` and is still fresh, otherwise null.
 */
export const verifyDeviceProofChallenge = async (
  profile: ProofSecret,
  challenge: Uint8Array,
  sessionId: string,
  nowMs: number,
): Promise<VerifiedChallenge | null> => {
  if (
    challenge.length !== DEVICE_PROOF_CHALLENGE_BYTES ||
    challenge[0] !== VERSION
  )
    return null;
  const nonce = challenge.slice(1, 1 + NONCE_BYTES);
  const issuedAtMs = readU64(challenge, 1 + NONCE_BYTES);
  if (
    !(await tagMatches(
      profile,
      challengeData(nonce, issuedAtMs, sessionId),
      challenge.slice(1 + NONCE_BYTES + 8),
    ))
  )
    return null;
  if (
    issuedAtMs > nowMs + ISSUED_IN_FUTURE_TOLERANCE_MS ||
    nowMs - issuedAtMs > DEVICE_PROOF_CHALLENGE_TTL_MS
  )
    return null;
  return Object.freeze({ nonce, issuedAtMs });
};

/**
 * The proof token for a verified challenge. Every field comes from the
 * challenge, so exchanging the same challenge again returns the same token
 * and never extends its life.
 */
export const issueDeviceProof = async (
  profile: ProofSecret,
  input: Readonly<{
    readonly challenge: VerifiedChallenge;
    readonly sessionId: string;
    readonly userId: string;
    readonly deviceId: string;
  }>,
): Promise<Readonly<{ token: string; expiresAtMs: number }>> => {
  const deviceId = uuidToBytes(input.deviceId);
  const expiresAtMs = input.challenge.issuedAtMs + DEVICE_PROOF_TTL_MS;
  const data = tokenData({
    deviceId,
    expiresAtMs,
    nonce: input.challenge.nonce,
    userId: input.userId,
    sessionId: input.sessionId,
  });
  return Object.freeze({
    token: encodeDeviceProofValue(
      concat(
        Uint8Array.of(VERSION),
        deviceId,
        u64(expiresAtMs),
        input.challenge.nonce,
        await tag(profile, data),
      ),
    ),
    expiresAtMs,
  });
};

/**
 * The Device id a proof token names, when the token is well formed, was
 * issued to this session and User, and has not expired. Otherwise null.
 */
export const verifyDeviceProof = async (
  profile: ProofSecret,
  token: string,
  input: Readonly<{
    readonly sessionId: string;
    readonly userId: string;
    readonly nowMs: number;
  }>,
): Promise<string | null> => {
  let bytes: Uint8Array;
  try {
    bytes = decodeDeviceProofValue(token, DEVICE_PROOF_TOKEN_BYTES);
  } catch {
    return null;
  }
  if (bytes[0] !== VERSION) return null;
  const deviceId = bytes.slice(1, 17);
  const expiresAtMs = readU64(bytes, 17);
  const nonce = bytes.slice(25, 25 + NONCE_BYTES);
  if (
    !(await tagMatches(
      profile,
      tokenData({
        deviceId,
        expiresAtMs,
        nonce,
        userId: input.userId,
        sessionId: input.sessionId,
      }),
      bytes.slice(25 + NONCE_BYTES),
    ))
  )
    return null;
  if (expiresAtMs <= input.nowMs) return null;
  // A token never outlives the lifetime the service grants, even if a
  // replica's clock ran ahead when the challenge was issued.
  if (
    expiresAtMs - input.nowMs >
    DEVICE_PROOF_TTL_MS + ISSUED_IN_FUTURE_TOLERANCE_MS
  )
    return null;
  return bytesToUuid(deviceId);
};

export const deviceProofLifetimeSeconds = (
  expiresAtMs: number,
  nowMs: number,
): number => Math.max(1, Math.floor((expiresAtMs - nowMs) / 1000));
