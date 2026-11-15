import { describe, expect, test } from "bun:test";
import { parseProtocolObject } from "@dotrelay/contracts";
import {
  accountFingerprint,
  deriveAccountSigningKey,
} from "../account/account-identity";
import {
  AccountRosterError,
  createAccountDeviceRoster,
  type RosterDevice,
  verifyAccountDeviceRoster,
} from "../account/roster";
import {
  confirmTeammateIdentity,
  decideDeviceTrust,
  emptyAccountTrustPins,
  parseAccountTrustPins,
  planOwnRoster,
  resolveAccountTrust,
  serializeAccountTrustPins,
} from "./account-trust";

const serverProfileId = "11111111-1111-4111-8111-111111111111";
const ownUserId = "22222222-2222-4222-8222-222222222222";
const teammateId = "33333333-3333-4333-8333-333333333333";

const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const randomAmk = () => crypto.getRandomValues(new Uint8Array(32));
const device = (id: string, revokedAtMs?: number): RosterDevice => ({
  deviceId: id,
  encryptionPublicKey: crypto.getRandomValues(new Uint8Array(32)),
  signingPublicKey: crypto.getRandomValues(new Uint8Array(32)),
  addedAtMs: 1_700_000_000_000,
  ...(revokedAtMs === undefined ? {} : { revokedAtMs }),
});

const rosterFor = async (
  amk: Uint8Array,
  userId: string,
  version: number,
  devices: readonly RosterDevice[],
) =>
  (
    await createAccountDeviceRoster({
      serverProfileId,
      userId,
      version,
      devices,
      signingKey: await deriveAccountSigningKey(amk, {
        serverProfileId,
        userId,
      }),
    })
  ).canonicalBytes;

describe("account signing key derivation", () => {
  test("matches the known-answer vector", async () => {
    // AMK 00..1f; the expected key was cross-checked with node:crypto HKDF
    // and Ed25519 independently of WebCrypto.
    const amk = Uint8Array.from({ length: 32 }, (_, index) => index);
    const key = await deriveAccountSigningKey(amk, {
      serverProfileId,
      userId: ownUserId,
    });
    expect(hex(key.identity)).toBe(
      "035c9c057d9743e8fe9266a37e37cf7e096244829dbe9dd8a0f8230ef8d62a82",
    );
    expect(await accountFingerprint(key.identity)).toBe(
      "fd83c3ad 188bd43b 424a0790 c7f2da51 f96f2b18",
    );
  });

  test("is stable per AMK and separated by Server Profile and User", async () => {
    const amk = randomAmk();
    const first = await deriveAccountSigningKey(amk, {
      serverProfileId,
      userId: ownUserId,
    });
    const again = await deriveAccountSigningKey(amk, {
      serverProfileId,
      userId: ownUserId,
    });
    const otherUser = await deriveAccountSigningKey(amk, {
      serverProfileId,
      userId: teammateId,
    });
    const otherProfile = await deriveAccountSigningKey(amk, {
      serverProfileId: teammateId,
      userId: ownUserId,
    });
    expect(hex(again.identity)).toBe(hex(first.identity));
    expect(hex(otherUser.identity)).not.toBe(hex(first.identity));
    expect(hex(otherProfile.identity)).not.toBe(hex(first.identity));
  });
});

describe("Account Device roster", () => {
  test("signs and verifies under the account identity", async () => {
    const amk = randomAmk();
    const devices = [device("44444444-4444-4444-8444-444444444444")];
    const bytes = await rosterFor(amk, ownUserId, 1, devices);
    const { identity } = await deriveAccountSigningKey(amk, {
      serverProfileId,
      userId: ownUserId,
    });
    const roster = await verifyAccountDeviceRoster(bytes, {
      serverProfileId,
      userId: ownUserId,
      identity,
    });
    expect(roster.version).toBe(1);
    expect(roster.devices[0]?.signingPublicKey).toEqual(
      devices[0]!.signingPublicKey,
    );
    expect(parseProtocolObject(bytes).get(1)).toBe(24);
  });

  test("rejects a roster under another identity or User", async () => {
    const bytes = await rosterFor(randomAmk(), ownUserId, 1, []);
    const { identity } = await deriveAccountSigningKey(randomAmk(), {
      serverProfileId,
      userId: ownUserId,
    });
    await expect(
      verifyAccountDeviceRoster(bytes, {
        serverProfileId,
        userId: ownUserId,
        identity,
      }),
    ).rejects.toBeInstanceOf(AccountRosterError);
  });
});

describe("resolving account trust", () => {
  const ownDevice = device("44444444-4444-4444-8444-444444444444");
  const teammateDevice = device("55555555-5555-4555-8555-555555555555");

  const scenario = async () => {
    const ownAmk = randomAmk();
    const teammateAmk = randomAmk();
    const ownIdentity = (
      await deriveAccountSigningKey(ownAmk, {
        serverProfileId,
        userId: ownUserId,
      })
    ).identity;
    return { ownAmk, teammateAmk, ownIdentity };
  };

  test("pins teammates on first sight and verifies their Devices", async () => {
    const { ownAmk, teammateAmk, ownIdentity } = await scenario();
    const resolution = await resolveAccountTrust({
      pins: emptyAccountTrustPins(),
      serverProfileId,
      ownUserId,
      ownIdentity,
      rosters: new Map([
        [ownUserId, await rosterFor(ownAmk, ownUserId, 1, [ownDevice])],
        [
          teammateId,
          await rosterFor(teammateAmk, teammateId, 1, [teammateDevice]),
        ],
      ]),
    });
    expect(resolution.users.get(ownUserId)?.status).toBe("verified");
    expect(resolution.users.get(teammateId)?.status).toBe("verified");
    expect(resolution.users.get(teammateId)?.newlyPinned).toBe(true);
    expect(resolution.pins.teammates[teammateId]?.rosterVersion).toBe(1);
    expect(
      decideDeviceTrust(resolution, {
        userId: teammateId,
        deviceId: teammateDevice.deviceId,
        signingPublicKey: teammateDevice.signingPublicKey,
      }),
    ).toEqual({ trusted: true, verified: true });
    // A first-sight pin verifies history only (ADR 0022): no key comes from
    // or goes to that teammate until the user confirms the identity.
    expect(resolution.users.get(teammateId)?.confirmed).toBe(false);
    expect(resolution.pins.teammates[teammateId]?.confirmed).toBe(false);
    expect(
      decideDeviceTrust(
        resolution,
        {
          userId: teammateId,
          deviceId: teammateDevice.deviceId,
          signingPublicKey: teammateDevice.signingPublicKey,
        },
        { purpose: "keys" },
      ),
    ).toEqual({ trusted: false, reason: "unconfirmed" });
  });

  test("a confirmed teammate's Devices may deliver keys, and stay confirmed", async () => {
    const { teammateAmk, ownIdentity } = await scenario();
    const roster = await rosterFor(teammateAmk, teammateId, 3, [
      teammateDevice,
    ]);
    const confirmed = await confirmTeammateIdentity(emptyAccountTrustPins(), {
      serverProfileId,
      userId: teammateId,
      roster,
    });
    expect(confirmed.rosterVersion).toBe(3);
    const resolution = await resolveAccountTrust({
      pins: confirmed.pins,
      serverProfileId,
      ownUserId,
      ownIdentity,
      rosters: new Map([[teammateId, roster]]),
    });
    expect(resolution.users.get(teammateId)?.confirmed).toBe(true);
    expect(
      decideDeviceTrust(
        resolution,
        {
          userId: teammateId,
          deviceId: teammateDevice.deviceId,
          signingPublicKey: teammateDevice.signingPublicKey,
        },
        { purpose: "keys" },
      ),
    ).toEqual({ trusted: true, verified: true });
    expect(resolution.pins.teammates[teammateId]?.confirmed).toBe(true);
  });

  test("a User the service leaves out of the rosters is resolved, not trusted", async () => {
    const { ownAmk, teammateAmk, ownIdentity } = await scenario();
    const pinned = (
      await resolveAccountTrust({
        pins: emptyAccountTrustPins(),
        serverProfileId,
        ownUserId,
        ownIdentity,
        rosters: new Map([
          [ownUserId, await rosterFor(ownAmk, ownUserId, 1, [ownDevice])],
          [
            teammateId,
            await rosterFor(teammateAmk, teammateId, 2, [teammateDevice]),
          ],
        ]),
      })
    ).pins;
    const invented = "99999999-9999-4999-8999-999999999999";
    const omitted = await resolveAccountTrust({
      pins: pinned,
      serverProfileId,
      ownUserId,
      ownIdentity,
      rosters: new Map([
        [ownUserId, await rosterFor(ownAmk, ownUserId, 1, [ownDevice])],
      ]),
      mentionedUserIds: [teammateId, invented],
    });
    // The pinned teammate's roster cannot vanish; a User never seen before
    // with no roster contributes nothing.
    expect(omitted.users.get(teammateId)?.status).toBe("rollback");
    expect(omitted.users.get(invented)?.status).toBe("unverified");
    for (const userId of [teammateId, invented])
      expect(
        decideDeviceTrust(omitted, {
          userId,
          deviceId: teammateDevice.deviceId,
          signingPublicKey: teammateDevice.signingPublicKey,
        }).trusted,
      ).toBe(false);
    // A User the resolution never saw at all is not trusted either.
    expect(
      decideDeviceTrust(omitted, {
        userId: "abababab-abab-4bab-8bab-abababababab",
        deviceId: teammateDevice.deviceId,
      }),
    ).toEqual({ trusted: false, reason: "unresolved" });
  });

  test("refuses a Device the service injected outside the roster", async () => {
    const { ownAmk, ownIdentity } = await scenario();
    const resolution = await resolveAccountTrust({
      pins: emptyAccountTrustPins(),
      serverProfileId,
      ownUserId,
      ownIdentity,
      rosters: new Map([
        [ownUserId, await rosterFor(ownAmk, ownUserId, 1, [ownDevice])],
      ]),
    });
    const injected = device("66666666-6666-4666-8666-666666666666");
    expect(
      decideDeviceTrust(resolution, {
        userId: ownUserId,
        deviceId: injected.deviceId,
        signingPublicKey: injected.signingPublicKey,
      }),
    ).toEqual({ trusted: false, reason: "not-in-roster" });
    // A listed Device with a swapped key is refused too.
    expect(
      decideDeviceTrust(resolution, {
        userId: ownUserId,
        deviceId: ownDevice.deviceId,
        encryptionPublicKey: injected.encryptionPublicKey,
      }),
    ).toEqual({ trusted: false, reason: "not-in-roster" });
  });

  test("rejects a roster the service signed with its own key for this User", async () => {
    const { ownIdentity } = await scenario();
    const forged = await rosterFor(randomAmk(), ownUserId, 1, [ownDevice]);
    const resolution = await resolveAccountTrust({
      pins: emptyAccountTrustPins(),
      serverProfileId,
      ownUserId,
      ownIdentity,
      rosters: new Map([[ownUserId, forged]]),
    });
    expect(resolution.users.get(ownUserId)?.status).toBe("identity-changed");
  });

  test("rejects roster rollback and disappearance after pinning", async () => {
    const { teammateAmk, ownIdentity } = await scenario();
    const pinned = (
      await resolveAccountTrust({
        pins: emptyAccountTrustPins(),
        serverProfileId,
        ownUserId,
        ownIdentity,
        rosters: new Map([
          [
            teammateId,
            await rosterFor(teammateAmk, teammateId, 2, [teammateDevice]),
          ],
        ]),
      })
    ).pins;
    const older = await resolveAccountTrust({
      pins: pinned,
      serverProfileId,
      ownUserId,
      ownIdentity,
      rosters: new Map([
        [
          teammateId,
          await rosterFor(teammateAmk, teammateId, 1, [teammateDevice]),
        ],
      ]),
    });
    expect(older.users.get(teammateId)?.status).toBe("rollback");
    const gone = await resolveAccountTrust({
      pins: pinned,
      serverProfileId,
      ownUserId,
      ownIdentity,
      rosters: new Map([[teammateId, null]]),
    });
    expect(gone.users.get(teammateId)?.status).toBe("rollback");
    expect(
      decideDeviceTrust(gone, {
        userId: teammateId,
        deviceId: teammateDevice.deviceId,
      }).trusted,
    ).toBe(false);
  });

  test("blocks a changed teammate identity until it is re-trusted", async () => {
    const { teammateAmk, ownIdentity } = await scenario();
    const pins = (
      await resolveAccountTrust({
        pins: emptyAccountTrustPins(),
        serverProfileId,
        ownUserId,
        ownIdentity,
        rosters: new Map([
          [
            teammateId,
            await rosterFor(teammateAmk, teammateId, 1, [teammateDevice]),
          ],
        ]),
      })
    ).pins;
    const swappedAmk = randomAmk();
    const swapped = await rosterFor(swappedAmk, teammateId, 5, [
      teammateDevice,
    ]);
    const blocked = await resolveAccountTrust({
      pins,
      serverProfileId,
      ownUserId,
      ownIdentity,
      rosters: new Map([[teammateId, swapped]]),
    });
    const user = blocked.users.get(teammateId)!;
    expect(user.status).toBe("identity-changed");
    expect(blocked.pins.teammates[teammateId]).toEqual(
      pins.teammates[teammateId]!,
    );
    expect(
      decideDeviceTrust(blocked, {
        userId: teammateId,
        deviceId: teammateDevice.deviceId,
        signingPublicKey: teammateDevice.signingPublicKey,
      }),
    ).toEqual({ trusted: false, reason: "identity-changed" });
    expect(user.presentedIdentity).not.toBeNull();
    const confirmed = await confirmTeammateIdentity(pins, {
      serverProfileId,
      userId: teammateId,
      roster: swapped,
    });
    // The re-trusted pin keeps the version the user verified, not 0.
    expect(confirmed.rosterVersion).toBe(5);
    const retrusted = await resolveAccountTrust({
      pins: confirmed.pins,
      serverProfileId,
      ownUserId,
      ownIdentity,
      rosters: new Map([[teammateId, swapped]]),
    });
    expect(retrusted.users.get(teammateId)?.status).toBe("verified");
    // So a later older or missing roster is still a rollback.
    const older = await resolveAccountTrust({
      pins: retrusted.pins,
      serverProfileId,
      ownUserId,
      ownIdentity,
      rosters: new Map([
        [
          teammateId,
          await rosterFor(swappedAmk, teammateId, 4, [teammateDevice]),
        ],
      ]),
    });
    expect(older.users.get(teammateId)?.status).toBe("rollback");
    const missing = await resolveAccountTrust({
      pins: retrusted.pins,
      serverProfileId,
      ownUserId,
      ownIdentity,
      rosters: new Map([[teammateId, null]]),
    });
    expect(missing.users.get(teammateId)?.status).toBe("rollback");
  });

  test("a User without any roster is unverified and trusted for nothing", async () => {
    const { ownIdentity } = await scenario();
    const resolution = await resolveAccountTrust({
      pins: emptyAccountTrustPins(),
      serverProfileId,
      ownUserId,
      ownIdentity,
      rosters: new Map([[teammateId, null]]),
    });
    expect(resolution.users.get(teammateId)?.status).toBe("unverified");
    expect(
      decideDeviceTrust(resolution, {
        userId: teammateId,
        deviceId: teammateDevice.deviceId,
      }),
    ).toEqual({ trusted: false, reason: "unverified" });
    // The own account without a roster trusts none of its Devices either.
    expect(resolution.users.get(ownUserId)?.status).toBe("unverified");
    expect(
      decideDeviceTrust(resolution, {
        userId: ownUserId,
        deviceId: ownDevice.deviceId,
      }).trusted,
    ).toBe(false);
  });

  test("a client with wiped state re-establishes trust only through the AMK", async () => {
    const { ownAmk, ownIdentity } = await scenario();
    const genuine = await rosterFor(ownAmk, ownUserId, 3, [ownDevice]);
    const forged = await rosterFor(randomAmk(), ownUserId, 9, [
      ownDevice,
      device("66666666-6666-4666-8666-666666666666"),
    ]);
    // No pins, but the identity is derived from the restored AMK: the
    // service's forged roster cannot be adopted.
    const restored = await resolveAccountTrust({
      pins: emptyAccountTrustPins(),
      serverProfileId,
      ownUserId,
      ownIdentity,
      rosters: new Map([[ownUserId, forged]]),
    });
    expect(restored.users.get(ownUserId)?.status).toBe("identity-changed");
    const genuineRestore = await resolveAccountTrust({
      pins: emptyAccountTrustPins(),
      serverProfileId,
      ownUserId,
      ownIdentity,
      rosters: new Map([[ownUserId, genuine]]),
    });
    expect(genuineRestore.users.get(ownUserId)?.status).toBe("verified");
    expect(genuineRestore.pins.own?.rosterVersion).toBe(3);
    // Without the AMK and without pins, the own identity is not taken on
    // first use from the service.
    const noAmk = await resolveAccountTrust({
      pins: emptyAccountTrustPins(),
      serverProfileId,
      ownUserId,
      ownIdentity: null,
      rosters: new Map([[ownUserId, forged]]),
    });
    expect(noAmk.users.get(ownUserId)?.status).toBe("unverified");
    expect(noAmk.pins.own).toBeNull();
    // A pin from before the wipe keeps working without the AMK.
    const pinnedNoAmk = await resolveAccountTrust({
      pins: genuineRestore.pins,
      serverProfileId,
      ownUserId,
      ownIdentity: null,
      rosters: new Map([[ownUserId, forged]]),
    });
    expect(pinnedNoAmk.users.get(ownUserId)?.status).toBe("identity-changed");
  });

  test("pins survive a serialize round trip and reject corruption", () => {
    const pins = {
      ...emptyAccountTrustPins(),
      teammates: {
        [teammateId]: {
          identity: "01".repeat(32),
          rosterVersion: 2,
          confirmed: true,
        },
      },
      projects: {
        "33333333-3333-4333-8333-333333333334": {
          highestEpoch: 3,
          keys: { "3": "ab".repeat(48) },
        },
      },
    };
    expect(parseAccountTrustPins(serializeAccountTrustPins(pins))).toEqual(
      pins,
    );
    // A file written before Project pins existed still parses.
    expect(
      parseAccountTrustPins(serializeAccountTrustPins(emptyAccountTrustPins()))
        .projects,
    ).toBeUndefined();
    expect(() => parseAccountTrustPins('{"version":2}')).toThrow();
    expect(() =>
      parseAccountTrustPins(
        JSON.stringify({
          ...pins,
          projects: { x: { highestEpoch: 0, keys: {} } },
        }),
      ),
    ).toThrow();
  });
});

describe("planning the own roster", () => {
  const self = {
    deviceId: "44444444-4444-4444-8444-444444444444",
    encryptionPublicKey: new Uint8Array(32).fill(1),
    signingPublicKey: new Uint8Array(32).fill(2),
    addedAtMs: 1,
  };
  const peer = {
    deviceId: "55555555-5555-4555-8555-555555555555",
    encryptionPublicKey: new Uint8Array(32).fill(3),
    signingPublicKey: new Uint8Array(32).fill(4),
    addedAtMs: 1,
  };

  test("the first roster lists only this Device, never the service's report", () => {
    const plan = planOwnRoster({
      current: null,
      self,
      reported: [
        peer,
        {
          ...peer,
          deviceId: "66666666-6666-4666-8666-666666666666",
          revokedAtMs: 9,
        },
      ],
    });
    expect(plan?.version).toBe(1);
    expect(plan?.devices.map((device) => device.deviceId)).toEqual([
      self.deviceId,
    ]);
  });

  test("a Device the user approved here joins the next roster", () => {
    const first = planOwnRoster({
      current: null,
      self,
      reported: [],
      approved: [peer],
    });
    expect(first?.devices.map((device) => device.deviceId).sort()).toEqual([
      self.deviceId,
      peer.deviceId,
    ]);
    const current = {
      userId: ownUserId,
      version: 2,
      identity: new Uint8Array(32),
      createdAtMs: 1,
      devices: [self],
    };
    const next = planOwnRoster({
      current,
      self,
      reported: [],
      approved: [peer],
    });
    expect(next?.version).toBe(3);
    expect(next?.devices.map((device) => device.deviceId).sort()).toEqual([
      self.deviceId,
      peer.deviceId,
    ]);
    // Already listed: nothing to publish.
    expect(
      planOwnRoster({
        current: { ...current, devices: [self, peer] },
        self,
        reported: [],
        approved: [peer],
      }),
    ).toBeNull();
  });

  test("never adds another Device, adds this one, and records revocations", () => {
    const current = {
      userId: ownUserId,
      version: 4,
      identity: new Uint8Array(32),
      createdAtMs: 1,
      devices: [peer],
    };
    const injected = {
      ...peer,
      deviceId: "77777777-7777-4777-8777-777777777777",
    };
    const plan = planOwnRoster({
      current,
      self,
      reported: [injected, { ...peer, revokedAtMs: 50 }],
    });
    expect(plan?.version).toBe(5);
    expect(plan?.devices.map((device) => device.deviceId).sort()).toEqual([
      self.deviceId,
      peer.deviceId,
    ]);
    expect(
      plan?.devices.find((device) => device.deviceId === peer.deviceId)
        ?.revokedAtMs,
    ).toBe(50);
  });

  test("a Device the service omits stays listed, and no change means no roster", () => {
    const current = {
      userId: ownUserId,
      version: 2,
      identity: new Uint8Array(32),
      createdAtMs: 1,
      devices: [self, peer],
    };
    expect(planOwnRoster({ current, self, reported: [] })).toBeNull();
  });

  test("a revoked Device cannot revive itself", () => {
    const current = {
      userId: ownUserId,
      version: 2,
      identity: new Uint8Array(32),
      createdAtMs: 1,
      devices: [{ ...self, revokedAtMs: 7 }],
    };
    expect(planOwnRoster({ current, self, reported: [self] })).toBeNull();
  });
});
