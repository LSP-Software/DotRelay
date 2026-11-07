import { readFile } from "node:fs/promises";
import {
  type AccountTrustPins,
  type AccountTrustResolution,
  createAccountDeviceRoster,
  decideDeviceTrust,
  deriveAccountSigningKey,
  emptyAccountTrustPins,
  isBlockingStatus,
  type OwnDeviceReport,
  parseAccountTrustPins,
  planOwnRoster,
  resolveAccountTrust,
  serializeAccountTrustPins,
} from "@dotrelay/client";
import { CliError } from "./errors";
import { atomicWriteProtectedFile } from "./output";
import {
  base64,
  type Boundary,
  bytesToHex,
  createDeviceAdmin,
  fromBase64,
  hexToBytes,
  type SigningTrustDevice,
  type WorkflowOptions,
} from "./workflow-core";

// Account identity pins live in the CLI state directory as a protected file
// (ADR 0015). Losing it means re-pinning teammates on first sight; the own
// identity always comes back from the AMK.
export const accountTrustPinsPath = (options: WorkflowOptions): string =>
  `${options.stateDirectory}/account-trust-${options.profile.pin.serverProfileId}.json`;

export const loadAccountTrustPins = async (
  options: WorkflowOptions,
): Promise<AccountTrustPins> => {
  let text: string;
  try {
    text = await readFile(accountTrustPinsPath(options), "utf8");
  } catch {
    return emptyAccountTrustPins();
  }
  try {
    return parseAccountTrustPins(text);
  } catch {
    throw new CliError(
      "crypto",
      `the account trust pins at ${accountTrustPinsPath(options)} are unreadable. Restore the file, or remove it and compare every teammate's fingerprint again`,
      {},
      "account_trust_pins_invalid",
    );
  }
};

export const saveAccountTrustPins = (
  options: WorkflowOptions,
  pins: AccountTrustPins,
): Promise<void> =>
  atomicWriteProtectedFile(
    accountTrustPinsPath(options),
    serializeAccountTrustPins(pins),
  );

const rosterBytes = (boundary: Boundary): Map<string, Uint8Array | null> =>
  new Map(
    [...boundary.accountRosters].map(([userId, roster]) => {
      if (roster === null) return [userId, null];
      try {
        return [userId, fromBase64(roster, "Account Device roster")];
      } catch {
        return [userId, new Uint8Array()];
      }
    }),
  );

// The Devices the service reports for this User, used only for the first
// roster (TOFU at upgrade) and to record revocations in later versions.
const reportedOwnDevices = (
  boundary: Boundary,
  userId: string,
): OwnDeviceReport[] => {
  const reported = new Map<string, OwnDeviceReport>();
  for (const device of boundary.signingTrustDevices) {
    if (device.userId !== userId || !device.encryptionPublicKey) continue;
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
  for (const peer of boundary.peerDevices) {
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

// Narrows the boundary to keys a verified roster vouches for. Users without
// a roster keep today's behaviour; blocked Users contribute nothing.
export const applyAccountTrust = (
  boundary: Boundary,
  resolution: AccountTrustResolution,
  ownUserId: string,
): Boundary => {
  const signingTrustDevices: SigningTrustDevice[] = [];
  for (const device of boundary.signingTrustDevices) {
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
  const signingTrustKeys = boundary.signingTrustKeys.filter((key) =>
    boundary.signingTrustDevices.length > 0
      ? keptKeys.has(key.toLowerCase())
      : ownRosterKeys === null
        ? own === undefined || !isBlockingStatus(own.status)
        : ownRosterKeys.has(key.toLowerCase()),
  );
  const peerDevices = boundary.peerDevices.filter((peer) => {
    try {
      // A roster-verified peer must match both keys; without a roster the
      // service's report is all there is.
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

export type AccountTrustOutcome = Readonly<{
  readonly boundary: Boundary;
  readonly resolution: AccountTrustResolution;
  readonly notices: readonly string[];
}>;

// Verifies the service's rosters, publishes this User's next roster when
// this Device holds the AMK and the roster is missing or stale, saves the
// pins, and returns the boundary narrowed to roster-verified keys.
export const establishAccountTrust = async (
  input: Readonly<{
    readonly options: WorkflowOptions;
    readonly boundary: Boundary;
    readonly userId: string;
    readonly deviceId: string;
    readonly accountMasterKey: Uint8Array | null;
    readonly encryptionPublicKey: Uint8Array;
    readonly signingPublicKey: Uint8Array;
  }>,
): Promise<AccountTrustOutcome> => {
  const { options, boundary, userId } = input;
  const serverProfileId = options.profile.pin.serverProfileId;
  const signingKey = input.accountMasterKey
    ? await deriveAccountSigningKey(input.accountMasterKey, {
        serverProfileId,
        userId,
      })
    : null;
  const pins = await loadAccountTrustPins(options);
  const rosters = rosterBytes(boundary);
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
  let own = resolution.users.get(userId);
  if (own && isBlockingStatus(own.status))
    throw new CliError(
      "crypto",
      own.status === "rollback"
        ? "the Server Profile returned an older Device roster for this account than this installation already verified. Do not trust this Server Profile until you have checked it"
        : "the Server Profile returned a Device roster for this account that the account key did not sign. Do not trust this Server Profile until you have checked it",
      { status: own.status },
      "account_roster_untrusted",
    );
  if (
    signingKey &&
    own &&
    (own.status === "verified" || own.status === "unverified")
  ) {
    const plan = planOwnRoster({
      current: own.status === "verified" ? own.roster : null,
      self: {
        deviceId: input.deviceId,
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
      const operationId = crypto.randomUUID();
      try {
        await createDeviceAdmin(options, input.deviceId).post(
          "/api/v1/account-keys/rosters",
          {
            operationId,
            objectId: roster.objectId,
            object: base64(roster.canonicalBytes),
          },
          ["objectId", "idempotent"],
          { idempotencyKey: operationId },
        );
        rosters.set(userId, roster.canonicalBytes);
        resolution = await resolve();
        own = resolution.users.get(userId);
      } catch {
        // Another Device of this User published first; the next run reads
        // and extends its roster.
      }
    }
  }
  if (resolution.changed) await saveAccountTrustPins(options, resolution.pins);
  const notices: string[] = [];
  const blocked = [...resolution.users.values()].filter((user) =>
    isBlockingStatus(user.status),
  );
  if (blocked.length > 0)
    notices.push(
      `${blocked.length} teammate account key${blocked.length === 1 ? "" : "s"} changed or rolled back; their Devices are not trusted. Run dotrelay team members --fingerprints, compare out of band, then dotrelay team trust <user-id>`,
    );
  return Object.freeze({
    boundary: applyAccountTrust(boundary, resolution, userId),
    resolution,
    notices,
  });
};
