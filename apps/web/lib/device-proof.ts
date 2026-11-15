import {
  createBrowserDeviceStorage,
  createDeviceProofSession,
  type DeviceProofSession,
  deviceProofSignerFromBundle,
  sendWithDeviceProof,
  uuidToBytes,
} from "@dotrelay/client";
import {
  fetchWorkspaceBoundary,
  type WorkspaceBoundary,
  type WorkspaceProfileId,
} from "./workspace-boundary";

// Device proof of possession for the browser (ADR 0020). Every Device-scoped
// API request proves this browser's Device: the Device signs a challenge
// from the service with its Ed25519 key (loaded from the browser Device
// store), and the signature buys a short-lived proof bound to the session
// cookie. One proof session per API origin and Device lives for the page's
// lifetime; it refreshes the proof before it expires.

export type BrowserDevice = Readonly<{
  /** The API origin the browser sends requests to. */
  readonly apiOrigin: string;
  /** The Server Profile pin the Device's keys are stored under. */
  readonly pin: Readonly<{
    readonly origin: string;
    readonly serverProfileId: string;
  }>;
  readonly deviceId: string;
  /**
   * The Device's key and User when the caller holds them in memory, as right
   * after bootstrap; otherwise the key is loaded from the Device store.
   */
  readonly signing?: Readonly<{
    readonly userId: string;
    readonly signingKey: CryptoKey;
  }>;
}>;

/** A refused challenge or proof exchange, with the service's problem code. */
export class DeviceProofRequestError extends Error {
  readonly code: string | null;
  constructor(code: string | null) {
    super("The server refused this browser's Device proof.");
    this.name = "DeviceProofRequestError";
    this.code = code;
  }
}

const sessions = new Map<string, DeviceProofSession>();
const sessionKey = (apiOrigin: string, deviceId: string) =>
  `${apiOrigin}\n${deviceId.toLowerCase()}`;

const exchangeAt =
  (apiOrigin: string) =>
  async (
    path: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<unknown> => {
    const response = await fetch(`${apiOrigin}${path}`, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed: unknown = await response.json().catch(() => null);
    if (!response.ok)
      throw new DeviceProofRequestError(
        parsed !== null &&
          typeof parsed === "object" &&
          "code" in parsed &&
          typeof parsed.code === "string"
          ? parsed.code
          : null,
      );
    return parsed;
  };

const loadStoredSigner = async (
  pin: Readonly<{ origin: string; serverProfileId: string }>,
  deviceId: string,
) => {
  try {
    return await deviceProofSignerFromBundle(
      await createBrowserDeviceStorage(pin).load({
        pin,
        deviceId: uuidToBytes(deviceId),
      }),
    );
  } catch {
    // The browser lost the Device's keys (cleared site data): it cannot
    // prove the Device and must be set up or recovered again.
    throw new DeviceProofRequestError("device_bundle_missing");
  }
};

/**
 * True when this browser cannot act as the Device at all: the service no
 * longer considers it active, its stored key does not match the one the
 * service registered, or the key is gone from this browser. A caller then
 * treats the browser as having no Device, as the session view reports.
 */
export const isDeviceUnavailable = (error: unknown): boolean =>
  error instanceof DeviceProofRequestError &&
  (error.code === "device_not_active" ||
    error.code === "invalid_crypto_object" ||
    error.code === "device_bundle_missing");

/**
 * The proof session for this browser's Device. Call it wherever the Device
 * and its pin are known; later requests that only know the API origin and
 * Device id find it with knownDeviceProof.
 */
export const browserDeviceProof = (
  device: BrowserDevice,
): DeviceProofSession => {
  const key = sessionKey(device.apiOrigin, device.deviceId);
  const existing = sessions.get(key);
  if (existing) return existing;
  const pin = {
    origin: device.pin.origin,
    serverProfileId: device.pin.serverProfileId,
  };
  const signing = device.signing;
  const session = createDeviceProofSession({
    deviceId: device.deviceId,
    exchange: exchangeAt(device.apiOrigin),
    signer: async () =>
      signing
        ? {
            serverProfileId: pin.serverProfileId,
            userId: signing.userId,
            deviceId: device.deviceId,
            signingKey: signing.signingKey,
          }
        : await loadStoredSigner(pin, device.deviceId),
  });
  sessions.set(key, session);
  return session;
};

/** The proof session registered for `deviceId` at `apiOrigin`, if any. */
export const knownDeviceProof = (
  apiOrigin: string,
  deviceId: string,
): DeviceProofSession | undefined =>
  sessions.get(sessionKey(apiOrigin, deviceId));

/** Forgets every proof session, for a sign-out or an account switch. */
export const forgetDeviceProofs = (): void => sessions.clear();

/**
 * Sends a Device-scoped request with the Device's proof, replacing a refused
 * proof once. Without a proof session the request goes out unproven and the
 * service refuses it.
 */
export const fetchWithDeviceProof = (
  proof: DeviceProofSession | undefined,
  input: string,
  init: RequestInit = {},
): Promise<Response> => {
  const send = (proofHeaders: Readonly<Record<string, string>>) => {
    // set() replaces a Device id claim the caller already added, so the
    // claim is never sent twice.
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(proofHeaders))
      headers.set(name, value);
    return fetch(input, { credentials: "include", ...init, headers });
  };
  return proof ? sendWithDeviceProof(proof, send) : send({});
};

/**
 * The workspace boundary as this browser's Device sees it, or the session
 * view when the browser cannot act as that Device (isDeviceUnavailable).
 */
export const fetchDeviceBoundary = async (
  profileId: WorkspaceProfileId,
  device: BrowserDevice,
  environmentId?: string | null,
): Promise<WorkspaceBoundary> => {
  const scope = environmentId ? { environmentId } : {};
  try {
    return await fetchWorkspaceBoundary(profileId, {
      device: browserDeviceProof(device),
      ...scope,
    });
  } catch (error) {
    if (!isDeviceUnavailable(error)) throw error;
    return fetchWorkspaceBoundary(profileId, scope);
  }
};
