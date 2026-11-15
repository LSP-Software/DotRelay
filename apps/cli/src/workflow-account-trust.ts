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
  reportedAccountSigningKeys,
  type SigningTrustDevice,
  type VerifiedSigners,
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

// The Devices the service reports revoked for this User. A roster version
// records them as revoked; nothing the service reports ever adds a Device.
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
  return [...reported.values()];
};

// The keys verified rosters vouch for, by what each may sign.
const verifiedSignersFor = (
  boundary: Boundary,
  resolution: AccountTrustResolution,
  ownUserId: string,
): VerifiedSigners => {
  const account: string[] = [];
  const grant: string[] = [];
  const history: string[] = [];
  for (const user of resolution.users.values()) {
    if (user.status !== "verified" || !user.roster) continue;
    for (const device of user.roster.devices) {
      const key = bytesToHex(device.signingPublicKey);
      history.push(key);
      if (user.userId === ownUserId) account.push(key);
      if (user.confirmed && device.revokedAtMs === undefined) grant.push(key);
    }
  }
  return Object.freeze({
    account: Object.freeze(account),
    reportedAccount: Object.freeze([...reportedAccountSigningKeys(boundary)]),
    grant: Object.freeze(grant),
    history: Object.freeze(history),
  });
};

// Narrows the boundary to keys a verified roster vouches for (ADR 0015,
// ADR 0022). A User without a verifiable roster, and a User the rosters
// leave out, contributes nothing; so does a blocked User.
export const applyAccountTrust = (
  boundary: Boundary,
  resolution: AccountTrustResolution,
  ownUserId: string,
  local?: Readonly<{ deviceId: string; signingPublicKey: Uint8Array }>,
): Boundary => {
  const signingTrustDevices: SigningTrustDevice[] = [];
  for (const device of boundary.signingTrustDevices) {
    let signingPublicKey: Uint8Array;
    try {
      signingPublicKey = hexToBytes(device.signingPublicKey);
    } catch {
      continue;
    }
    // This Device's own entry carries its own key, which no roster needs to
    // vouch for; its windows also set the authored-at floor.
    if (
      local &&
      device.userId === ownUserId &&
      device.deviceId.toLowerCase() === local.deviceId.toLowerCase() &&
      bytesToHex(signingPublicKey) === bytesToHex(local.signingPublicKey)
    ) {
      signingTrustDevices.push(device);
      continue;
    }
    const decision = decideDeviceTrust(resolution, {
      userId: device.userId,
      deviceId: device.deviceId,
      signingPublicKey,
    });
    if (!decision.trusted) continue;
    const revokedAtMs = decision.revokedAtMs;
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
  const verifiedSigners = verifiedSignersFor(boundary, resolution, ownUserId);
  const vouched = new Set(verifiedSigners.history);
  const signingTrustKeys = boundary.signingTrustKeys.filter((key) =>
    vouched.has(key.toLowerCase()),
  );
  // Peers receive the Project Epoch Key and the Account Master Key, so each
  // must be an active Device of this account's verified roster with both of
  // its rostered keys.
  const peerDevices = boundary.peerDevices.filter((peer) => {
    try {
      return decideDeviceTrust(
        resolution,
        {
          userId: ownUserId,
          deviceId: peer.id,
          signingPublicKey: hexToBytes(peer.signingPublicKey),
          encryptionPublicKey: hexToBytes(peer.encryptionPublicKey),
        },
        { requireActive: true, purpose: "keys" },
      ).trusted;
    } catch {
      return false;
    }
  });
  return Object.freeze({
    ...boundary,
    signingTrustDevices,
    signingTrustKeys,
    verifiedSigners,
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
// `approved` names Devices the user approved on this Device (an enrollment
// it approved, an Account Key Transfer target the user confirmed); they join
// the roster with this publication.
export const establishAccountTrust = async (
  input: Readonly<{
    readonly options: WorkflowOptions;
    readonly boundary: Boundary;
    readonly userId: string;
    readonly deviceId: string;
    readonly accountMasterKey: Uint8Array | null;
    readonly encryptionPublicKey: Uint8Array;
    readonly signingPublicKey: Uint8Array;
    readonly approved?: readonly OwnDeviceReport[];
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
      mentionedUserIds: boundary.signingTrustDevices.map(
        (device) => device.userId,
      ),
    });
  let resolution = await resolve();
  const own = resolution.users.get(userId);
  if (own && isBlockingStatus(own.status))
    throw new CliError(
      "crypto",
      own.status === "rollback"
        ? "the Server Profile returned an older Device roster for this account than this installation already verified, or none at all. Do not trust this Server Profile until you have checked it"
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
      ...(input.approved ? { approved: input.approved } : {}),
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
  const firstSight = [...resolution.users.values()].filter(
    (user) => user.newlyPinned,
  );
  if (firstSight.length > 0)
    notices.push(
      `Pinned ${firstSight.length} teammate account key${firstSight.length === 1 ? "" : "s"} seen for the first time on this installation. Their Revisions verify, but no Project key is taken from them until you compare fingerprints (dotrelay team members --fingerprints) and run dotrelay team trust <user-id>`,
    );
  return Object.freeze({
    boundary: applyAccountTrust(boundary, resolution, userId, {
      deviceId: input.deviceId,
      signingPublicKey: input.signingPublicKey,
    }),
    resolution,
    notices,
  });
};
