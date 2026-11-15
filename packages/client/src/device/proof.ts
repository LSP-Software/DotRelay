import {
  bytesToUuid,
  DEVICE_ID_HEADER,
  DEVICE_PROOF_HEADER,
  deviceProofMessage,
  encodeDeviceProofValue,
  parseDeviceProof,
  parseDeviceProofChallenge,
  parseUuid,
} from "@dotrelay/contracts";
import type { DevicePrivateBundle } from "./bundle";
import { loadDeviceKeyMaterial } from "./bundle";

// Device proof of possession (ADR 0020). A Device-scoped request carries a
// short-lived proof that the Device obtains by signing a challenge from the
// service. One DeviceProofSession per Device and session caches the proof,
// refreshes it before it expires, and replaces it after the service refuses
// it.

/** What proving one Device needs: its ids and its Ed25519 signing key. */
export type DeviceProofSigner = Readonly<{
  readonly serverProfileId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly signingKey: CryptoKey;
}>;

/**
 * A session-authenticated JSON POST: resolves the response body, and throws
 * (the client's own error) for any problem response. Proof requests carry
 * the session's credentials and never a Device proof.
 */
export type DeviceProofExchange = (
  path: string,
  body: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

export type DeviceProofSession = Readonly<{
  readonly deviceId: string;
  /**
   * The headers that prove this Device: the proof and the Device id claim.
   * Obtains a new proof when none is cached or the cached one is about to
   * expire.
   */
  headers(): Promise<Readonly<Record<string, string>>>;
  /**
   * Forgets the proof in `headers` after the service refused it, so the next
   * headers() call obtains a new one. A newer proof is kept.
   */
  invalidate(headers: Readonly<Record<string, string>>): void;
}>;

// Refresh this long before the proof expires on the client's own clock.
const REFRESH_MARGIN_MS = 30_000;
const PROOF_CHALLENGES_PATH = "/api/v1/devices/proofs/challenges";
const PROOFS_PATH = "/api/v1/devices/proofs";

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export class DeviceProofError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceProofError";
  }
}

export const createDeviceProofSession = (
  input: Readonly<{
    readonly deviceId: string;
    readonly exchange: DeviceProofExchange;
    /** Loaded on first use, so a client that never needs a Device never reads its key. */
    readonly signer: () => Promise<DeviceProofSigner>;
    readonly now?: () => number;
  }>,
): DeviceProofSession => {
  const deviceId = parseUuid(input.deviceId, "deviceId");
  const now = input.now ?? Date.now;
  let cached: Readonly<{ token: string; refreshAtMs: number }> | undefined;
  let pending: Promise<string> | undefined;
  const obtain = async (): Promise<string> => {
    const signer = await input.signer();
    if (parseUuid(signer.deviceId, "deviceId") !== deviceId)
      throw new DeviceProofError("the Device key belongs to another Device");
    const requestedAtMs = now();
    const challenge = parseDeviceProofChallenge(
      await input.exchange(PROOF_CHALLENGES_PATH, {}),
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        signer.signingKey,
        deviceProofMessage({
          serverProfileId: signer.serverProfileId,
          userId: signer.userId,
          deviceId,
          challenge: challenge.challenge,
        }),
      ),
    );
    const proof = parseDeviceProof(
      await input.exchange(PROOFS_PATH, {
        deviceId,
        challenge: encodeDeviceProofValue(challenge.challenge),
        signature: toBase64(signature),
      }),
    );
    if (proof.deviceId !== deviceId)
      throw new DeviceProofError("the service proved a different Device");
    const lifetimeMs = proof.expiresIn * 1000;
    cached = Object.freeze({
      token: proof.token,
      // Counted from before the challenge was requested, so the proof never
      // outlives what the client believes.
      refreshAtMs:
        requestedAtMs +
        Math.max(lifetimeMs / 2, lifetimeMs - REFRESH_MARGIN_MS),
    });
    return proof.token;
  };
  const token = async (): Promise<string> => {
    if (cached && now() < cached.refreshAtMs) return cached.token;
    // One exchange at a time; concurrent requests share its result.
    pending ??= obtain().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  return Object.freeze({
    deviceId,
    headers: async () =>
      Object.freeze({
        [DEVICE_ID_HEADER]: deviceId,
        [DEVICE_PROOF_HEADER]: await token(),
      }),
    invalidate: (headers: Readonly<Record<string, string>>) => {
      if (cached && headers[DEVICE_PROOF_HEADER] === cached.token)
        cached = undefined;
    },
  });
};

/**
 * Sends a Device-scoped request with the session's proof headers. The
 * service rejects a request without a valid proof before any route logic
 * runs, so after a 401 the same request is sent once more with a new proof;
 * a lost session then fails while getting that proof.
 */
export const sendWithDeviceProof = async <
  Result extends Readonly<{ readonly status: number }>,
>(
  session: DeviceProofSession,
  send: (headers: Readonly<Record<string, string>>) => Promise<Result>,
): Promise<Result> => {
  const headers = await session.headers();
  const response = await send(headers);
  if (response.status !== 401) return response;
  session.invalidate(headers);
  return send(await session.headers());
};

/** The proof signer for a stored Device bundle. */
export const deviceProofSignerFromBundle = async (
  bundle: DevicePrivateBundle,
): Promise<DeviceProofSigner> =>
  Object.freeze({
    serverProfileId: bundle.pin.serverProfileId,
    userId: bytesToUuid(bundle.userId),
    deviceId: bytesToUuid(bundle.deviceId),
    signingKey: (await loadDeviceKeyMaterial(bundle)).signingPrivateKey,
  });
