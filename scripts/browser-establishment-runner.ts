import {
  authenticatedCreatorKeys,
  createAccountKeyWrapper,
  createDeviceBootstrap,
  type DeviceBootstrap,
  decodeRecoveryCode,
  encodeRecoveryCode,
  generateAccountMasterKey,
  generateRecoveryCode,
  parseAccountKeyWrapper,
  unwrapAccountKeyWrapper,
} from "@dotrelay/client";
import {
  canonicalEncode,
  exportSigningPublicKey,
  sha384,
  sha384ToHex,
  uuidToBytes,
} from "@dotrelay/contracts";

// Chromium side of a first-establishment race. This is the same device
// bootstrap and wrapper publication the browser recovery flow performs
// (provisionBrowserDevice, publishAccountKeyWrapper): a real page on the
// API origin, session cookie included, no fixture. It is not the Recovery
// React page. The Account Master Key and recovery code stay in this page
// until the race result is returned, and a loss zeroes the candidate.

type EstablishConfig = Readonly<{
  readonly origin: string;
  readonly serverProfileId: string;
  readonly userId: string;
}>;

type PreparedDevice = Readonly<{
  readonly config: EstablishConfig;
  readonly bootstrap: DeviceBootstrap;
}>;

type RaceResult =
  | Readonly<{
      readonly outcome: "won";
      readonly recoveryCode: string;
      readonly wrapperId: string;
    }>
  | Readonly<{ readonly outcome: "lost" }>;

let prepared: PreparedDevice | null = null;

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const fromHex = (value: string): Uint8Array => {
  const hex = value.trim().toLowerCase();
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(hex))
    throw new Error("browser establishment saw a malformed key");
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const pair = hex.slice(index * 2, index * 2 + 2);
    bytes[index] = Number.parseInt(pair, 16);
  }
  return bytes;
};

const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const problemCode = async (response: Response): Promise<string> => {
  const body: unknown = await response.json().catch(() => null);
  if (
    typeof body === "object" &&
    body !== null &&
    "code" in body &&
    typeof body.code === "string"
  )
    return body.code;
  return "service_unavailable";
};

const deviceHeaders = (
  deviceId: string,
  operationId?: string,
): Record<string, string> => ({
  "Content-Type": "application/json",
  "X-DotRelay-Device-Id": deviceId,
  ...(operationId ? { "Idempotency-Key": operationId } : {}),
});

const prepareBrowserDevice = async (
  config: EstablishConfig,
): Promise<{ readonly deviceId: string }> => {
  const bootstrap = await createDeviceBootstrap({
    pin: { serverProfileId: config.serverProfileId, origin: config.origin },
    userId: config.userId,
  });
  const response = await fetch(`${config.origin}/api/v1/devices/bootstrap`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId: crypto.randomUUID(),
      deviceId: bootstrap.deviceId,
      identityGeneration: bootstrap.identityGeneration,
      keyId: toHex(bootstrap.keyId),
      x25519PublicKey: toHex(bootstrap.x25519PublicKey),
      ed25519PublicKey: toHex(bootstrap.ed25519PublicKey),
      certificateId: bootstrap.certificate.id,
      certificate: toBase64(bootstrap.certificate.canonicalBytes),
    }),
  });
  if (!response.ok)
    throw new Error(
      `browser device bootstrap failed: ${await problemCode(response)}`,
    );
  prepared = { config, bootstrap };
  return { deviceId: bootstrap.deviceId };
};

const establishFromBrowser = async (): Promise<RaceResult> => {
  const current = prepared;
  if (!current) throw new Error("browser device was not prepared");
  const { config, bootstrap } = current;
  const listed = await fetch(`${config.origin}/api/v1/account-keys/wrappers`, {
    credentials: "include",
    headers: { "X-DotRelay-Device-Id": bootstrap.deviceId },
    cache: "no-store",
  });
  if (!listed.ok)
    throw new Error(
      `browser wrapper list failed: ${await problemCode(listed)}`,
    );
  const listedBody: unknown = await listed.json();
  const wrappers =
    typeof listedBody === "object" &&
    listedBody !== null &&
    "wrappers" in listedBody &&
    Array.isArray(listedBody.wrappers)
      ? listedBody.wrappers
      : null;
  if (!wrappers) throw new Error("browser wrapper list was malformed");
  if (wrappers.length > 0) return { outcome: "lost" };
  const accountMasterKey = generateAccountMasterKey();
  const recoveryCode = generateRecoveryCode();
  try {
    const wrapper = await createAccountKeyWrapper({
      serverProfileId: config.serverProfileId,
      userId: uuidToBytes(config.userId),
      deviceId: uuidToBytes(bootstrap.deviceId),
      userIdentityGeneration: bootstrap.identityGeneration,
      createdAtMs: Date.now(),
      accountMasterKey,
      signingPrivateKey: bootstrap.keyMaterial.signingPrivateKey,
      kind: { type: "recoveryCode", recoveryCode },
    });
    const operationId = crypto.randomUUID();
    const response = await fetch(
      `${config.origin}/api/v1/account-keys/wrappers`,
      {
        method: "POST",
        credentials: "include",
        headers: deviceHeaders(bootstrap.deviceId, operationId),
        body: JSON.stringify({
          operationId,
          objectId: crypto.randomUUID(),
          object: toBase64(canonicalEncode(wrapper.object)),
          wrapperId: toHex(wrapper.wrapperId),
          identityGeneration: String(bootstrap.identityGeneration),
          ciphertextHash: sha384ToHex(await sha384(wrapper.ciphertext)),
          ciphertextLength: wrapper.ciphertext.length,
          intent: "establish",
        }),
      },
    );
    if (!response.ok) {
      const code = await problemCode(response);
      if (code === "state_conflict") return { outcome: "lost" };
      throw new Error(`browser establishment failed: ${code}`);
    }
    return {
      outcome: "won",
      recoveryCode: encodeRecoveryCode(recoveryCode),
      wrapperId: toHex(wrapper.wrapperId),
    };
  } finally {
    accountMasterKey.fill(0);
    recoveryCode.fill(0);
  }
};

const unlockWinningRecoveryCode = async (
  recoveryCodeText: string,
): Promise<{ readonly accountMasterKeyLength: number }> => {
  const current = prepared;
  if (!current) throw new Error("browser device was not prepared");
  const { config, bootstrap } = current;
  const headers = { "X-DotRelay-Device-Id": bootstrap.deviceId };
  const boundaryResponse = await fetch(
    `${config.origin}/api/v1/workspace/boundary`,
    { credentials: "include", headers, cache: "no-store" },
  );
  if (!boundaryResponse.ok)
    throw new Error(
      `browser trust history failed: ${await problemCode(boundaryResponse)}`,
    );
  const boundary: unknown = await boundaryResponse.json();
  const history = trustHistory(boundary);
  const wrappersResponse = await fetch(
    `${config.origin}/api/v1/account-keys/wrappers`,
    { credentials: "include", headers, cache: "no-store" },
  );
  if (!wrappersResponse.ok)
    throw new Error(
      `browser wrapper list failed: ${await problemCode(wrappersResponse)}`,
    );
  const wrappersBody: unknown = await wrappersResponse.json();
  const entry = firstWrapper(wrappersBody);
  if (!entry) throw new Error("browser found no winning recovery wrapper");
  const claimed =
    entry.creatorPublicKey === undefined ? [] : [entry.creatorPublicKey];
  const trustedHex = [
    ...history,
    ...authenticatedCreatorKeys(claimed, history),
  ];
  const signingPublicKey = bootstrap.keyMaterial.signingPublicKey;
  if (!signingPublicKey) throw new Error("browser device has no signing key");
  const localSigningKey = await exportSigningPublicKey(signingPublicKey);
  const keys = [localSigningKey];
  const seen = new Set<string>([toHex(localSigningKey)]);
  for (const hex of trustedHex) {
    const bytes = fromHex(hex);
    if (bytes.length !== 32) continue;
    const normalized = toHex(bytes);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    keys.push(bytes);
  }
  const recoveryCode = decodeRecoveryCode(recoveryCodeText);
  try {
    const accountMasterKey = await unwrapAccountKeyWrapper(
      parseAccountKeyWrapper(fromBase64(entry.object)),
      { recoveryCode },
      {
        trustedKeys: { keys },
        context: {
          serverProfileId: uuidToBytes(config.serverProfileId),
          userId: uuidToBytes(config.userId),
        },
      },
    );
    const accountMasterKeyLength = accountMasterKey.length;
    accountMasterKey.fill(0);
    return { accountMasterKeyLength };
  } finally {
    recoveryCode.fill(0);
  }
};

const trustHistory = (boundary: unknown): string[] => {
  if (typeof boundary !== "object" || boundary === null) return [];
  const record = boundary as Record<string, unknown>;
  const keys: string[] = [];
  if (Array.isArray(record.signingTrustKeys)) {
    for (const key of record.signingTrustKeys)
      if (typeof key === "string") keys.push(key);
  }
  if (Array.isArray(record.peerDevices)) {
    for (const peer of record.peerDevices) {
      if (
        typeof peer === "object" &&
        peer !== null &&
        "signingPublicKey" in peer &&
        typeof peer.signingPublicKey === "string"
      )
        keys.push(peer.signingPublicKey);
    }
  }
  return keys;
};

const firstWrapper = (
  body: unknown,
): { readonly object: string; readonly creatorPublicKey?: string } | null => {
  if (typeof body !== "object" || body === null || !("wrappers" in body))
    return null;
  const wrappers = body.wrappers;
  if (!Array.isArray(wrappers)) return null;
  for (const raw of wrappers) {
    if (typeof raw !== "object" || raw === null) continue;
    const candidate = raw as Record<string, unknown>;
    if (candidate.type !== "recovery-code") continue;
    if (typeof candidate.object !== "string") continue;
    if (typeof candidate.creatorPublicKey === "string")
      return {
        object: candidate.object,
        creatorPublicKey: candidate.creatorPublicKey,
      };
    return { object: candidate.object };
  }
  return null;
};

const pageGlobal = globalThis as typeof globalThis & {
  dotRelayPrepareBrowserDevice: typeof prepareBrowserDevice;
  dotRelayEstablishFromBrowser: typeof establishFromBrowser;
  dotRelayUnlockWinningRecoveryCode: typeof unlockWinningRecoveryCode;
};
pageGlobal.dotRelayPrepareBrowserDevice = prepareBrowserDevice;
pageGlobal.dotRelayEstablishFromBrowser = establishFromBrowser;
pageGlobal.dotRelayUnlockWinningRecoveryCode = unlockWinningRecoveryCode;
