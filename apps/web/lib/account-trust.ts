import {
  type AccountTrustPins,
  type AccountTrustResolution,
  accountFingerprint,
  createAccountDeviceRoster,
  createBrowserDeviceStorage,
  decideDeviceTrust,
  deriveAccountSigningKey,
  emptyAccountTrustPins,
  isBlockingStatus,
  type OwnDeviceReport,
  parseAccountTrustPins,
  planOwnRoster,
  resolveAccountTrust,
  retrustTeammate,
  serializeAccountTrustPins,
  uuidToBytes,
} from "@dotrelay/client";
import {
  type AccountKeyActor,
  fromBase64,
  hexToBytes,
  publishAccountDeviceRoster,
} from "./account-keys";
import type {
  WorkspaceBoundary,
  WorkspaceSigningTrustDevice,
} from "./workspace-boundary";

// Browser side of ADR 0015: account identity pins live in the wrapped
// IndexedDB Device record store, the own identity comes from the unlocked
// AMK, and every service-reported key list is narrowed to roster-verified
// keys before use. Mirrors apps/cli/src/workflow-account-trust.ts.

type Pin = Readonly<{ serverProfileId: string; origin: string }>;

const bytesToHex = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const loadBrowserAccountTrustPins = async (
  pin: Pin,
  deviceId: string,
): Promise<AccountTrustPins> => {
  const text = await createBrowserDeviceStorage(pin).loadAccountTrustPins(
    uuidToBytes(deviceId),
  );
  return text === null ? emptyAccountTrustPins() : parseAccountTrustPins(text);
};

export const saveBrowserAccountTrustPins = (
  pin: Pin,
  deviceId: string,
  pins: AccountTrustPins,
): Promise<void> =>
  createBrowserDeviceStorage(pin).saveAccountTrustPins(
    uuidToBytes(deviceId),
    serializeAccountTrustPins(pins),
  );

export const rosterBytesFrom = (
  rosters: Readonly<Record<string, string | null>> | undefined,
): Map<string, Uint8Array | null> =>
  new Map(
    Object.entries(rosters ?? {}).map(([userId, roster]) => {
      if (roster === null) return [userId, null];
      try {
        return [userId, fromBase64(roster)];
      } catch {
        return [userId, new Uint8Array()];
      }
    }),
  );

const reportedOwnDevices = (
  boundary: WorkspaceBoundary,
  userId: string,
): OwnDeviceReport[] => {
  const reported = new Map<string, OwnDeviceReport>();
  for (const device of boundary.signingTrustDevices ?? []) {
    if (
      device.userId !== userId ||
      !device.deviceId ||
      !device.encryptionPublicKey
    )
      continue;
    try {
      reported.set(device.deviceId, {
        deviceId: device.deviceId,
        encryptionPublicKey: hexToBytes(device.encryptionPublicKey),
        signingPublicKey: hexToBytes(device.signingPublicKey),
        addedAtMs: device.deviceActiveFromMs ?? 0,
        ...(device.deviceActiveUntilMs === null
          ? {}
          : { revokedAtMs: device.deviceActiveUntilMs }),
      });
    } catch {
      // A malformed key is not reported.
    }
  }
  for (const peer of boundary.peerDevices ?? []) {
    if (reported.has(peer.id)) continue;
    try {
      reported.set(peer.id, {
        deviceId: peer.id,
        encryptionPublicKey: hexToBytes(peer.encryptionPublicKey),
        signingPublicKey: hexToBytes(peer.signingPublicKey),
        addedAtMs: 0,
      });
    } catch {
      // A malformed key is not reported.
    }
  }
  return [...reported.values()];
};

// Narrows the boundary to roster-verified keys: Users without a roster keep
// today's behaviour; blocked Users contribute no key at all.
export const applyBrowserAccountTrust = (
  boundary: WorkspaceBoundary,
  resolution: AccountTrustResolution,
  ownUserId: string,
): WorkspaceBoundary => {
  const signingTrustDevices: WorkspaceSigningTrustDevice[] = [];
  for (const device of boundary.signingTrustDevices ?? []) {
    if (!device.userId || !device.deviceId) {
      // Unattributed entries can only be trusted while nobody is verified.
      const anyVerified = [...resolution.users.values()].some(
        (user) => user.status === "verified",
      );
      if (!anyVerified) signingTrustDevices.push(device);
      continue;
    }
    let signingPublicKey: Uint8Array;
    try {
      signingPublicKey = hexToBytes(device.signingPublicKey);
    } catch {
      continue;
    }
    const decision = decideDeviceTrust(resolution, {
      userId: device.userId,
      deviceId: device.deviceId,
      signingPublicKey,
    });
    if (!decision.trusted) continue;
    const revokedAtMs =
      decision.verified && "revokedAtMs" in decision
        ? decision.revokedAtMs
        : undefined;
    signingTrustDevices.push(
      revokedAtMs === undefined
        ? device
        : {
            ...device,
            deviceActiveUntilMs:
              device.deviceActiveUntilMs === null
                ? revokedAtMs
                : Math.min(device.deviceActiveUntilMs, revokedAtMs),
          },
    );
  }
  const own = resolution.users.get(ownUserId);
  const ownRosterKeys =
    own?.status === "verified" && own.roster
      ? new Set(
          own.roster.devices.map((device) =>
            bytesToHex(device.signingPublicKey),
          ),
        )
      : null;
  const keptKeys = new Set(
    signingTrustDevices.map((device) => device.signingPublicKey.toLowerCase()),
  );
  const hadDevices = (boundary.signingTrustDevices ?? []).length > 0;
  const signingTrustKeys = (boundary.signingTrustKeys ?? []).filter((key) =>
    hadDevices
      ? keptKeys.has(key.toLowerCase())
      : ownRosterKeys === null
        ? own === undefined || !isBlockingStatus(own.status)
        : ownRosterKeys.has(key.toLowerCase()),
  );
  const peerDevices = (boundary.peerDevices ?? []).filter((peer) => {
    try {
      if (own?.status === "verified" && peer.signingPublicKey.length !== 64)
        return false;
      return decideDeviceTrust(
        resolution,
        {
          userId: ownUserId,
          deviceId: peer.id,
          ...(peer.signingPublicKey.length > 0
            ? { signingPublicKey: hexToBytes(peer.signingPublicKey) }
            : {}),
          encryptionPublicKey: hexToBytes(peer.encryptionPublicKey),
        },
        { requireActive: true },
      ).trusted;
    } catch {
      return false;
    }
  });
  return Object.freeze({
    ...boundary,
    signingTrustDevices,
    signingTrustKeys,
    peerDevices,
  });
};

export class AccountRosterUntrustedError extends Error {
  constructor() {
    super(
      "The server returned a Device list for your account that your account key did not sign. Don't trust this server until you've checked it.",
    );
    this.name = "AccountRosterUntrustedError";
  }
}

// Verifies rosters, publishes this User's next roster when this browser
// holds the AMK, persists the pins, and returns the narrowed boundary.
export const establishBrowserAccountTrust = async (
  input: Readonly<{
    readonly boundary: WorkspaceBoundary;
    readonly accountMasterKey: Uint8Array | null;
    readonly actor: AccountKeyActor | null;
    readonly encryptionPublicKey: Uint8Array;
    readonly signingPublicKey: Uint8Array;
    /** Test seam: replaces wrapped IndexedDB pin storage. */
    readonly pinStore?: Readonly<{
      load: () => Promise<AccountTrustPins>;
      save: (pins: AccountTrustPins) => Promise<void>;
    }>;
    readonly publish?: typeof publishAccountDeviceRoster;
  }>,
): Promise<
  Readonly<{
    boundary: WorkspaceBoundary;
    resolution: AccountTrustResolution;
  }>
> => {
  const { boundary } = input;
  const userId = boundary.session.userId;
  const deviceId = boundary.device.id;
  const serverProfileId = boundary.profile.serverProfileId;
  if (!userId || !deviceId || !serverProfileId)
    throw new Error("account trust needs a signed-in Device");
  const pin = { serverProfileId, origin: boundary.profile.origin };
  const store = input.pinStore ?? {
    load: () => loadBrowserAccountTrustPins(pin, deviceId),
    save: (pins: AccountTrustPins) =>
      saveBrowserAccountTrustPins(pin, deviceId, pins),
  };
  const signingKey = input.accountMasterKey
    ? await deriveAccountSigningKey(input.accountMasterKey, {
        serverProfileId,
        userId,
      })
    : null;
  const pins = await store.load();
  const rosters = rosterBytesFrom(boundary.accountRosters);
  if (!rosters.has(userId)) rosters.set(userId, null);
  const resolve = () =>
    resolveAccountTrust({
      pins,
      serverProfileId,
      ownUserId: userId,
      ownIdentity: signingKey?.identity ?? null,
      rosters,
    });
  let resolution = await resolve();
  const own = resolution.users.get(userId);
  if (own && isBlockingStatus(own.status))
    throw new AccountRosterUntrustedError();
  if (signingKey && input.actor && own) {
    const plan = planOwnRoster({
      current: own.status === "verified" ? own.roster : null,
      self: {
        deviceId,
        encryptionPublicKey: input.encryptionPublicKey,
        signingPublicKey: input.signingPublicKey,
        addedAtMs: Date.now(),
      },
      reported: reportedOwnDevices(boundary, userId),
    });
    if (plan) {
      const roster = await createAccountDeviceRoster({
        serverProfileId,
        userId,
        version: plan.version,
        devices: plan.devices,
        signingKey,
      });
      try {
        await (input.publish ?? publishAccountDeviceRoster)(
          input.actor,
          roster,
        );
        rosters.set(userId, roster.canonicalBytes);
        resolution = await resolve();
      } catch {
        // Another Device published first; the next refresh extends it.
      }
    }
  }
  if (resolution.changed) await store.save(resolution.pins);
  return {
    boundary: applyBrowserAccountTrust(boundary, resolution, userId),
    resolution,
  };
};

// The Members view: each Member's trust state and fingerprint, pinning
// first-sight identities as a side effect (trust on first use).
export const resolveMemberTrust = async (
  input: Readonly<{
    readonly pin: Pin;
    readonly deviceId: string;
    readonly ownUserId: string;
    readonly accountMasterKey: Uint8Array | null;
    readonly members: ReadonlyArray<
      Readonly<{ userId: string; accountRoster?: string | null }>
    >;
  }>,
): Promise<
  ReadonlyMap<
    string,
    Readonly<{
      status: string;
      fingerprint: string | null;
      presentedIdentity: Uint8Array | null;
    }>
  >
> => {
  const pins = await loadBrowserAccountTrustPins(input.pin, input.deviceId);
  const ownIdentity = input.accountMasterKey
    ? (
        await deriveAccountSigningKey(input.accountMasterKey, {
          serverProfileId: input.pin.serverProfileId,
          userId: input.ownUserId,
        })
      ).identity
    : null;
  const resolution = await resolveAccountTrust({
    pins,
    serverProfileId: input.pin.serverProfileId,
    ownUserId: input.ownUserId,
    ownIdentity,
    rosters: rosterBytesFrom(
      Object.fromEntries(
        input.members.map((member) => [
          member.userId,
          member.accountRoster ?? null,
        ]),
      ),
    ),
  });
  if (resolution.changed)
    await saveBrowserAccountTrustPins(
      input.pin,
      input.deviceId,
      resolution.pins,
    );
  const result = new Map<
    string,
    Readonly<{
      status: string;
      fingerprint: string | null;
      presentedIdentity: Uint8Array | null;
    }>
  >();
  for (const [userId, user] of resolution.users) {
    const shown = user.presentedIdentity ?? user.identity;
    result.set(userId, {
      status: user.status,
      fingerprint: shown ? await accountFingerprint(shown) : null,
      presentedIdentity: user.presentedIdentity,
    });
  }
  return result;
};

export class ProvisioningRecipientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisioningRecipientError";
  }
}

// Every Device a provisioning plan would send Project keys to must be an
// active Device in the member's verified roster with the same X25519 key. A
// changed or rolled-back account key blocks provisioning until re-trusted.
export const assertProvisioningRecipients = (
  resolution: AccountTrustResolution,
  memberUserId: string,
  devices: ReadonlyArray<Readonly<{ id: string; encryptionPublicKey: string }>>,
): "verified" | "unverified" => {
  const member = resolution.users.get(memberUserId);
  if (member && isBlockingStatus(member.status))
    throw new ProvisioningRecipientError(
      "This member's account key changed. Compare their fingerprint in Members and trust it before sharing project keys.",
    );
  for (const device of devices) {
    let encryptionPublicKey: Uint8Array;
    try {
      encryptionPublicKey = hexToBytes(device.encryptionPublicKey);
    } catch {
      throw new ProvisioningRecipientError("Recipient key is invalid");
    }
    const decision = decideDeviceTrust(
      resolution,
      { userId: memberUserId, deviceId: device.id, encryptionPublicKey },
      { requireActive: true },
    );
    if (!decision.trusted)
      throw new ProvisioningRecipientError(
        "The server listed a Device that isn't in this member's signed Device list. No keys were shared.",
      );
  }
  return member?.status === "verified" ? "verified" : "unverified";
};

// Resolves one member's roster against this browser's pins (pinning a
// first-sight identity) for provisioning.
export const resolveProvisioningTrust = async (
  input: Readonly<{
    readonly pin: Pin;
    readonly deviceId: string;
    readonly ownUserId: string;
    readonly accountMasterKey: Uint8Array;
    readonly memberUserId: string;
    readonly accountRoster: string | null;
  }>,
): Promise<AccountTrustResolution> => {
  const pins = await loadBrowserAccountTrustPins(input.pin, input.deviceId);
  const resolution = await resolveAccountTrust({
    pins,
    serverProfileId: input.pin.serverProfileId,
    ownUserId: input.ownUserId,
    ownIdentity: (
      await deriveAccountSigningKey(input.accountMasterKey, {
        serverProfileId: input.pin.serverProfileId,
        userId: input.ownUserId,
      })
    ).identity,
    rosters: rosterBytesFrom({ [input.memberUserId]: input.accountRoster }),
  });
  if (resolution.changed)
    await saveBrowserAccountTrustPins(
      input.pin,
      input.deviceId,
      resolution.pins,
    );
  return resolution;
};

export const retrustMember = async (
  pin: Pin,
  deviceId: string,
  userId: string,
  identity: Uint8Array,
): Promise<void> => {
  const pins = await loadBrowserAccountTrustPins(pin, deviceId);
  await saveBrowserAccountTrustPins(
    pin,
    deviceId,
    retrustTeammate(pins, userId, identity),
  );
};
