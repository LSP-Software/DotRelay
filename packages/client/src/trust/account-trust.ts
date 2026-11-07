import {
  type AccountDeviceRoster,
  type RosterDevice,
  readAccountDeviceRoster,
  verifyAccountDeviceRoster,
} from "../account/roster";

// Local pins for account identities (ADR 0015). The client's own identity is
// pinned after it derives it from the AMK; a teammate's on first sight.
export type AccountTrustPin = Readonly<{
  /** Hex of the 32-byte account identity. */
  readonly identity: string;
  /** Highest roster version verified under this identity. */
  readonly rosterVersion: number;
}>;

export type AccountTrustPins = Readonly<{
  readonly version: 1;
  readonly own: (AccountTrustPin & { readonly userId: string }) | null;
  readonly teammates: Readonly<Record<string, AccountTrustPin>>;
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
  (value as AccountTrustPin).rosterVersion >= 0;

// Parses stored pins. Anything malformed is an error, not an empty store:
// silently forgetting pins would turn every teammate back into first sight.
export const parseAccountTrustPins = (text: string): AccountTrustPins => {
  const value = JSON.parse(text) as Record<string, unknown>;
  const own = value.own as Record<string, unknown> | null;
  const teammates = value.teammates as Record<string, unknown>;
  if (
    value.version !== 1 ||
    (own !== null &&
      (!isPin(own) ||
        typeof (own as { userId?: unknown }).userId !== "string")) ||
    teammates === null ||
    typeof teammates !== "object" ||
    !Object.values(teammates).every(isPin)
  )
    throw new Error("account trust pins are malformed");
  return Object.freeze({
    version: 1,
    own: own as AccountTrustPins["own"],
    teammates: Object.freeze({
      ...(teammates as Record<string, AccountTrustPin>),
    }),
  });
};

export const serializeAccountTrustPins = (pins: AccountTrustPins): string =>
  `${JSON.stringify(pins)}\n`;

export type AccountTrustStatus =
  /** Devices come from a roster signed by the pinned or derived identity. */
  | "verified"
  /** No roster exists and none was ever pinned: today's behaviour, flagged. */
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

// Resolves trust for the own User and every teammate whose roster (or
// absence of one) the service reported. `ownIdentity` is derived from the
// AMK when this client holds it; without it the pinned own identity is used.
export const resolveAccountTrust = async (
  input: Readonly<{
    readonly pins: AccountTrustPins;
    readonly serverProfileId: string;
    readonly ownUserId: string;
    readonly ownIdentity: Uint8Array | null;
    /** userId -> latest roster bytes; every User the boundary covers. */
    readonly rosters: ReadonlyMap<string, Uint8Array | null>;
  }>,
): Promise<AccountTrustResolution> => {
  const teammates: Record<string, AccountTrustPin> = {
    ...input.pins.teammates,
  };
  let own = input.pins.own?.userId === input.ownUserId ? input.pins.own : null;
  let changed = false;
  const users = new Map<string, UserAccountTrust>();
  const userIds = new Set([input.ownUserId, ...input.rosters.keys()]);
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
          ...fields,
        }),
      );
    if (!bytes) {
      // A roster that existed for a pinned User cannot simply disappear.
      result(pin && pin.rosterVersion > 0 ? "rollback" : "unverified");
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
    const next = { identity: hex(identity), rosterVersion: roster.version };
    const newlyPinned = !pin || pin.identity !== next.identity;
    if (!pin || pin.rosterVersion !== next.rosterVersion || newlyPinned) {
      changed = true;
      if (isOwn) own = { ...next, userId };
      else teammates[userId] = next;
    }
    result("verified", {
      identity,
      roster,
      newlyPinned: newlyPinned && !isOwn,
    });
  }
  return Object.freeze({
    pins: Object.freeze({
      version: 1,
      own,
      teammates: Object.freeze(teammates),
    }),
    users,
    changed,
  });
};

// Explicit re-trust of a teammate whose identity changed, after the user
// compared fingerprints out of band. The roster version restarts.
export const retrustTeammate = (
  pins: AccountTrustPins,
  userId: string,
  identity: Uint8Array,
): AccountTrustPins =>
  Object.freeze({
    ...pins,
    teammates: Object.freeze({
      ...pins.teammates,
      [userId]: { identity: hex(identity), rosterVersion: 0 },
    }),
  });

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
  | Readonly<{ trusted: true; verified: false }>
  | Readonly<{ trusted: false; reason: AccountTrustStatus | "not-in-roster" }>;

// Decides whether one service-reported Device key may be trusted. A
// verified User's Device must be in the roster with the same keys; an
// unverified User keeps today's behaviour; a blocking status trusts nothing.
export const decideDeviceTrust = (
  resolution: AccountTrustResolution,
  claim: DeviceKeyClaim,
  options: Readonly<{ requireActive?: boolean }> = {},
): DeviceTrustDecision => {
  const user = resolution.users.get(claim.userId);
  if (!user || user.status === "unverified")
    return { trusted: true, verified: false };
  if (user.status !== "verified" || !user.roster)
    return { trusted: false, reason: user.status };
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

// The roster this client should publish next, or null when the latest
// verified roster already matches. Rules (ADR 0015):
// - with no roster yet, list every Device the service reports (TOFU at
//   upgrade), active and revoked, plus this Device;
// - otherwise never add a Device other than this one, add or refresh this
//   Device, and mark revoked any listed Device the service reports revoked.
//   A Device the service merely omits stays listed: silence is not a
//   revocation, and the service must not be able to shrink the roster.
export const planOwnRoster = (
  input: Readonly<{
    readonly current: AccountDeviceRoster | null;
    readonly self: OwnDeviceReport;
    readonly reported: readonly OwnDeviceReport[];
  }>,
): Readonly<{ version: number; devices: RosterDevice[] }> | null => {
  if (!input.current) {
    const devices = new Map<string, RosterDevice>();
    for (const device of [...input.reported, input.self])
      devices.set(device.deviceId, { ...device });
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
  return changed ? { version: input.current.version + 1, devices } : null;
};
