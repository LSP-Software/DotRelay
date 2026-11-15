import {
  type AccountDeviceRoster,
  type RosterDevice,
  readAccountDeviceRoster,
  verifyAccountDeviceRoster,
} from "../account/roster";

// Local pins for account identities (ADR 0015, ADR 0022). The client's own
// identity is pinned after it derives it from the AMK. A teammate's is pinned
// on first sight for verifying history only; the user confirms it before any
// key is taken from or given to that teammate on its say-so.
export type AccountTrustPin = Readonly<{
  /** Hex of the 32-byte account identity. */
  readonly identity: string;
  /** Highest roster version verified under this identity. */
  readonly rosterVersion: number;
  /**
   * Teammates only: the user confirmed this identity (compared its
   * fingerprint) instead of it being pinned on first sight.
   */
  readonly confirmed?: boolean;
}>;

/**
 * What this installation has accepted for one Project (ADR 0022): the
 * highest Project epoch, and a commitment to the Project Epoch Key it adopted
 * for each epoch, so neither can be rolled back or swapped later.
 */
export type ProjectEpochPin = Readonly<{
  readonly highestEpoch: number;
  /** Project epoch (decimal) -> hex commitment to that epoch's key. */
  readonly keys: Readonly<Record<string, string>>;
}>;

export type AccountTrustPins = Readonly<{
  readonly version: 1;
  readonly own: (AccountTrustPin & { readonly userId: string }) | null;
  readonly teammates: Readonly<Record<string, AccountTrustPin>>;
  /** Project id -> epoch and key pins. Absent in files written before it. */
  readonly projects?: Readonly<Record<string, ProjectEpochPin>>;
}>;

export const emptyAccountTrustPins = (): AccountTrustPins =>
  Object.freeze({ version: 1, own: null, teammates: Object.freeze({}) });

const hex = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

const fromHex = (value: string): Uint8Array =>
  Uint8Array.from(value.match(/../g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );

const isPin = (value: unknown): value is AccountTrustPin =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as AccountTrustPin).identity === "string" &&
  /^[0-9a-f]{64}$/.test((value as AccountTrustPin).identity) &&
  Number.isSafeInteger((value as AccountTrustPin).rosterVersion) &&
  (value as AccountTrustPin).rosterVersion >= 0 &&
  ((value as AccountTrustPin).confirmed === undefined ||
    typeof (value as AccountTrustPin).confirmed === "boolean");

const isProjectPin = (value: unknown): value is ProjectEpochPin => {
  if (value === null || typeof value !== "object") return false;
  const pin = value as ProjectEpochPin;
  return (
    Number.isSafeInteger(pin.highestEpoch) &&
    pin.highestEpoch >= 1 &&
    pin.keys !== null &&
    typeof pin.keys === "object" &&
    Object.entries(pin.keys).every(
      ([epoch, commitment]) =>
        /^[1-9][0-9]{0,15}$/.test(epoch) &&
        typeof commitment === "string" &&
        /^[0-9a-f]{96}$/.test(commitment),
    )
  );
};

// Parses stored pins. Anything malformed is an error, not an empty store:
// silently forgetting pins would turn every teammate back into first sight.
export const parseAccountTrustPins = (text: string): AccountTrustPins => {
  const value = JSON.parse(text) as Record<string, unknown>;
  const own = value.own as Record<string, unknown> | null;
  const teammates = value.teammates as Record<string, unknown>;
  const projects = value.projects as Record<string, unknown> | undefined;
  if (
    value.version !== 1 ||
    (own !== null &&
      (!isPin(own) ||
        typeof (own as { userId?: unknown }).userId !== "string")) ||
    teammates === null ||
    typeof teammates !== "object" ||
    !Object.values(teammates).every(isPin) ||
    (projects !== undefined &&
      (projects === null ||
        typeof projects !== "object" ||
        !Object.values(projects).every(isProjectPin)))
  )
    throw new Error("account trust pins are malformed");
  return Object.freeze({
    version: 1,
    own: own as AccountTrustPins["own"],
    teammates: Object.freeze({
      ...(teammates as Record<string, AccountTrustPin>),
    }),
    ...(projects === undefined
      ? {}
      : {
          projects: Object.freeze({
            ...(projects as Record<string, ProjectEpochPin>),
          }),
        }),
  });
};

export const serializeAccountTrustPins = (pins: AccountTrustPins): string =>
  `${JSON.stringify(pins)}\n`;

export type AccountTrustStatus =
  /** Devices come from a roster signed by the pinned or derived identity. */
  | "verified"
  /**
   * No roster this client can verify: none was ever pinned and none was
   * served, or (own account) this client holds neither the AMK nor a pin.
   * No Device of this User is trusted (ADR 0022).
   */
  | "unverified"
  /** The roster names a different identity than the pinned one. Blocking. */
  | "identity-changed"
  /** The roster is older than the pinned version, or vanished. Blocking. */
  | "rollback"
  /** The roster does not verify under the identity it should. Blocking. */
  | "invalid";

export type UserAccountTrust = Readonly<{
  readonly userId: string;
  readonly status: AccountTrustStatus;
  /** The identity the Devices were verified under, or the one claimed. */
  readonly identity: Uint8Array | null;
  /** For identity-changed: the identity the service now presents. */
  readonly presentedIdentity: Uint8Array | null;
  readonly roster: AccountDeviceRoster | null;
  /** True when this resolution pinned the identity for the first time. */
  readonly newlyPinned: boolean;
  /**
   * The own account, or a teammate whose identity the user confirmed.
   * Only confirmed Users' Devices may deliver or receive keys (ADR 0022).
   */
  readonly confirmed: boolean;
}>;

export type AccountTrustResolution = Readonly<{
  readonly pins: AccountTrustPins;
  readonly users: ReadonlyMap<string, UserAccountTrust>;
  readonly changed: boolean;
}>;

export const isBlockingStatus = (status: AccountTrustStatus): boolean =>
  status === "identity-changed" ||
  status === "rollback" ||
  status === "invalid";

// Resolves trust for the own User, every User whose roster (or absence of
// one) the service reported, and every User a key list names. Nothing is
// trusted from absent data: a User without a verifiable roster contributes
// no Device, and a pinned User whose roster is missing is a rollback.
// `ownIdentity` is derived from the AMK when this client holds it; without it
// the pinned own identity is used.
export const resolveAccountTrust = async (
  input: Readonly<{
    readonly pins: AccountTrustPins;
    readonly serverProfileId: string;
    readonly ownUserId: string;
    readonly ownIdentity: Uint8Array | null;
    /** userId -> latest roster bytes; every User the boundary covers. */
    readonly rosters: ReadonlyMap<string, Uint8Array | null>;
    /**
     * Every User any service-reported key list names (signing trust
     * Devices, provisioning plans). Each is resolved even when the service
     * left it out of `rosters`.
     */
    readonly mentionedUserIds?: Iterable<string>;
  }>,
): Promise<AccountTrustResolution> => {
  const teammates: Record<string, AccountTrustPin> = {
    ...input.pins.teammates,
  };
  let own = input.pins.own?.userId === input.ownUserId ? input.pins.own : null;
  let changed = false;
  const users = new Map<string, UserAccountTrust>();
  const userIds = new Set([
    input.ownUserId,
    ...input.rosters.keys(),
    ...(input.mentionedUserIds ?? []),
  ]);
  for (const userId of userIds) {
    const isOwn = userId === input.ownUserId;
    const pin = isOwn ? own : (teammates[userId] ?? null);
    const expected = isOwn
      ? (input.ownIdentity ?? (pin ? fromHex(pin.identity) : null))
      : pin
        ? fromHex(pin.identity)
        : null;
    const bytes = input.rosters.get(userId) ?? null;
    const result = (
      status: AccountTrustStatus,
      fields: Partial<UserAccountTrust> = {},
    ) =>
      users.set(
        userId,
        Object.freeze({
          userId,
          status,
          identity: expected,
          presentedIdentity: null,
          roster: null,
          newlyPinned: false,
          confirmed: isOwn || pin?.confirmed === true,
          ...fields,
        }),
      );
    if (!bytes) {
      // A roster that existed for a pinned User cannot simply disappear,
      // whether the service sends null or leaves the User out.
      result(pin ? "rollback" : "unverified");
      continue;
    }
    // The own identity is never taken on first use: it comes from the AMK
    // or an earlier pin, or the User stays unverified until a restore.
    if (isOwn && !expected) {
      result("unverified");
      continue;
    }
    let claimed: AccountDeviceRoster;
    try {
      claimed = readAccountDeviceRoster(bytes);
    } catch {
      result("invalid");
      continue;
    }
    const identity = expected ?? claimed.identity;
    if (expected && hex(expected) !== hex(claimed.identity)) {
      result("identity-changed", { presentedIdentity: claimed.identity });
      continue;
    }
    let roster: AccountDeviceRoster;
    try {
      roster = await verifyAccountDeviceRoster(bytes, {
        serverProfileId: input.serverProfileId,
        userId,
        identity,
      });
    } catch {
      result("invalid", { identity });
      continue;
    }
    if (
      pin &&
      hex(identity) === pin.identity &&
      roster.version < pin.rosterVersion
    ) {
      result("rollback", { identity });
      continue;
    }
    const newlyPinned = !pin || pin.identity !== hex(identity);
    // A first-sight pin verifies history only; confirmation is explicit.
    const confirmed = isOwn || (!newlyPinned && pin?.confirmed === true);
    const next = {
      identity: hex(identity),
      rosterVersion: roster.version,
      ...(isOwn ? {} : { confirmed }),
    };
    if (!pin || pin.rosterVersion !== next.rosterVersion || newlyPinned) {
      changed = true;
      if (isOwn) own = { ...next, userId };
      else teammates[userId] = next;
    }
    result("verified", {
      identity,
      roster,
      newlyPinned: newlyPinned && !isOwn,
      confirmed,
    });
  }
  return Object.freeze({
    pins: Object.freeze({
      ...input.pins,
      version: 1,
      own,
      teammates: Object.freeze(teammates),
    }),
    users,
    changed,
  });
};

/**
 * The user confirmed a teammate's account identity after comparing its
 * fingerprint out of band: a first-sight identity, or a changed one. The
 * roster the service presents must verify under that identity, and the pin
 * keeps its version (never lower than one already verified for the same
 * identity), so the next missing or older roster is still a rollback.
 */
export const confirmTeammateIdentity = async (
  pins: AccountTrustPins,
  input: Readonly<{
    readonly serverProfileId: string;
    readonly userId: string;
    readonly roster: Uint8Array;
  }>,
): Promise<
  Readonly<{
    readonly pins: AccountTrustPins;
    readonly identity: Uint8Array;
    readonly rosterVersion: number;
  }>
> => {
  const claimed = readAccountDeviceRoster(input.roster);
  const roster = await verifyAccountDeviceRoster(input.roster, {
    serverProfileId: input.serverProfileId,
    userId: input.userId,
    identity: claimed.identity,
  });
  const previous = pins.teammates[input.userId];
  const rosterVersion =
    previous && previous.identity === hex(roster.identity)
      ? Math.max(previous.rosterVersion, roster.version)
      : roster.version;
  return Object.freeze({
    pins: Object.freeze({
      ...pins,
      teammates: Object.freeze({
        ...pins.teammates,
        [input.userId]: {
          identity: hex(roster.identity),
          rosterVersion,
          confirmed: true,
        },
      }),
    }),
    identity: roster.identity,
    rosterVersion,
  });
};

const activeAt = (device: RosterDevice): boolean =>
  device.revokedAtMs === undefined;

const sameKey = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  left.every((byte, index) => byte === right[index]);

export type DeviceKeyClaim = Readonly<{
  readonly userId: string;
  readonly deviceId: string;
  readonly signingPublicKey?: Uint8Array;
  readonly encryptionPublicKey?: Uint8Array;
}>;

export type DeviceTrustDecision =
  | Readonly<{ trusted: true; verified: true; revokedAtMs?: number }>
  | Readonly<{
      trusted: false;
      reason:
        AccountTrustStatus | "not-in-roster" | "unresolved" | "unconfirmed";
    }>;

/**
 * What a Device key is trusted for. `history` verifies Revisions and other
 * signed history. `keys` covers key material: accepting a Project Epoch Key
 * or Account Master Key signed by the Device, or sealing keys to it. A
 * teammate pinned on first sight counts for history only, until the user
 * confirms the identity (ADR 0022).
 */
export type DeviceTrustPurpose = "history" | "keys";

// Decides whether one service-reported Device key may be trusted. The
// Device's User must be resolved and verified, and the roster must list the
// Device with the same keys. A User with no verifiable roster, a User the
// resolution never saw, and a blocking status all trust nothing.
export const decideDeviceTrust = (
  resolution: AccountTrustResolution,
  claim: DeviceKeyClaim,
  options: Readonly<{
    requireActive?: boolean;
    purpose?: DeviceTrustPurpose;
  }> = {},
): DeviceTrustDecision => {
  const user = resolution.users.get(claim.userId);
  if (!user) return { trusted: false, reason: "unresolved" };
  if (user.status !== "verified" || !user.roster)
    return { trusted: false, reason: user.status };
  if (options.purpose === "keys" && !user.confirmed)
    return { trusted: false, reason: "unconfirmed" };
  const device = user.roster.devices.find(
    (candidate) => candidate.deviceId === claim.deviceId,
  );
  if (
    !device ||
    (claim.signingPublicKey &&
      !sameKey(device.signingPublicKey, claim.signingPublicKey)) ||
    (claim.encryptionPublicKey &&
      !sameKey(device.encryptionPublicKey, claim.encryptionPublicKey)) ||
    (options.requireActive && !activeAt(device))
  )
    return { trusted: false, reason: "not-in-roster" };
  return device.revokedAtMs === undefined
    ? { trusted: true, verified: true }
    : { trusted: true, verified: true, revokedAtMs: device.revokedAtMs };
};

export type OwnDeviceReport = Readonly<{
  readonly deviceId: string;
  readonly encryptionPublicKey: Uint8Array;
  readonly signingPublicKey: Uint8Array;
  readonly addedAtMs: number;
  /** Set when the service reports the Device revoked. */
  readonly revokedAtMs?: number;
}>;

const entryFor = (device: OwnDeviceReport): RosterDevice => ({
  deviceId: device.deviceId,
  encryptionPublicKey: device.encryptionPublicKey,
  signingPublicKey: device.signingPublicKey,
  addedAtMs: device.addedAtMs,
});

// The roster this client should publish next, or null when the latest
// verified roster already matches. Rules (ADR 0015, ADR 0022):
// - a Device enters the roster only as the publishing Device itself, or as
//   a Device the user approved here (`approved`: an enrollment this Device
//   approved, or the target of an Account Key Transfer the user confirmed).
//   The service's report never adds a Device, not even to a first roster;
// - add or refresh this Device, and mark revoked any listed Device the
//   service reports revoked. A Device the service merely omits stays listed:
//   silence is not a revocation, and the service must not be able to shrink
//   the roster. A revoked entry stays revoked.
export const planOwnRoster = (
  input: Readonly<{
    readonly current: AccountDeviceRoster | null;
    readonly self: OwnDeviceReport;
    readonly reported: readonly OwnDeviceReport[];
    readonly approved?: readonly OwnDeviceReport[];
  }>,
): Readonly<{ version: number; devices: RosterDevice[] }> | null => {
  const approved = input.approved ?? [];
  if (!input.current) {
    const devices = new Map<string, RosterDevice>([
      [input.self.deviceId, entryFor(input.self)],
    ]);
    for (const device of approved)
      if (!devices.has(device.deviceId))
        devices.set(device.deviceId, entryFor(device));
    return { version: 1, devices: [...devices.values()] };
  }
  let changed = false;
  const reported = new Map(
    input.reported.map((device) => [device.deviceId, device]),
  );
  const devices = input.current.devices.map((device): RosterDevice => {
    if (
      device.deviceId === input.self.deviceId ||
      device.revokedAtMs !== undefined
    )
      return device;
    const report = reported.get(device.deviceId);
    if (!report || report.revokedAtMs === undefined) return device;
    changed = true;
    return { ...device, revokedAtMs: report.revokedAtMs };
  });
  const selfIndex = devices.findIndex(
    (device) => device.deviceId === input.self.deviceId,
  );
  const listed = selfIndex >= 0 ? devices[selfIndex] : undefined;
  if (
    !listed ||
    listed.revokedAtMs !== undefined ||
    !sameKey(listed.signingPublicKey, input.self.signingPublicKey) ||
    !sameKey(listed.encryptionPublicKey, input.self.encryptionPublicKey)
  ) {
    // A revoked entry stays revoked; this client cannot revive itself.
    if (listed?.revokedAtMs !== undefined)
      return changed ? { version: input.current.version + 1, devices } : null;
    const entry: RosterDevice = {
      deviceId: input.self.deviceId,
      encryptionPublicKey: input.self.encryptionPublicKey,
      signingPublicKey: input.self.signingPublicKey,
      addedAtMs: listed?.addedAtMs ?? input.self.addedAtMs,
    };
    if (selfIndex >= 0) devices[selfIndex] = entry;
    else devices.push(entry);
    changed = true;
  }
  for (const device of approved) {
    if (devices.some((listed) => listed.deviceId === device.deviceId)) continue;
    devices.push(entryFor(device));
    changed = true;
  }
  return changed ? { version: input.current.version + 1, devices } : null;
};
