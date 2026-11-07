import { describe, expect, test } from "bun:test";
import {
  type AccountTrustPins,
  createAccountDeviceRoster,
  deriveAccountSigningKey,
  emptyAccountTrustPins,
  type RosterDevice,
  resolveAccountTrust,
  verifyAccountDeviceRoster,
} from "@dotrelay/client";
import {
  AccountRosterUntrustedError,
  applyBrowserAccountTrust,
  assertProvisioningRecipients,
  establishBrowserAccountTrust,
  ProvisioningRecipientError,
} from "./account-trust";
import type { WorkspaceBoundary } from "./workspace-boundary";

const serverProfileId = "11111111-1111-4111-8111-111111111111";
const ownUserId = "22222222-2222-4222-8222-222222222222";
const teammateId = "33333333-3333-4333-8333-333333333333";
const ownDeviceId = "44444444-4444-4444-8444-444444444444";
const peerDeviceId = "55555555-5555-4555-8555-555555555555";
const injectedDeviceId = "66666666-6666-4666-8666-666666666666";
const teammateDeviceId = "77777777-7777-4777-8777-777777777777";

const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const randomKey = () => crypto.getRandomValues(new Uint8Array(32));
const device = (deviceId: string): RosterDevice => ({
  deviceId,
  encryptionPublicKey: randomKey(),
  signingPublicKey: randomKey(),
  addedAtMs: 1,
});

const roster = async (
  amk: Uint8Array,
  userId: string,
  version: number,
  devices: readonly RosterDevice[],
) =>
  Buffer.from(
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
    ).canonicalBytes,
  ).toString("base64");

const boundaryWith = (
  own: RosterDevice,
  peers: readonly RosterDevice[],
  teammate: RosterDevice,
  accountRosters: Record<string, string | null>,
): WorkspaceBoundary =>
  ({
    source: "live",
    connection: "online",
    session: { active: true, userId: ownUserId },
    profile: {
      id: "relay",
      name: "Relay",
      origin: "https://relay.example",
      serverProfileId,
    },
    device: {
      active: true,
      id: own.deviceId,
      encryptionPublicKey: hex(own.encryptionPublicKey),
      signingPublicKey: hex(own.signingPublicKey),
    },
    grantsReady: true,
    epochCurrent: true,
    rotationRequired: false,
    signingTrustDevices: [own, ...peers, teammate].map((entry) => ({
      deviceId: entry.deviceId,
      userId: entry === teammate ? teammateId : ownUserId,
      signingPublicKey: hex(entry.signingPublicKey),
      encryptionPublicKey: hex(entry.encryptionPublicKey),
      deviceActiveFromMs: 0,
      deviceActiveUntilMs: null,
      memberSinceMs: 0,
      memberUntilMs: null,
    })),
    peerDevices: peers.map((peer) => ({
      id: peer.deviceId,
      encryptionPublicKey: hex(peer.encryptionPublicKey),
      signingPublicKey: hex(peer.signingPublicKey),
      hasEpochGrant: false,
    })),
    accountRosters,
    crypto: { available: true },
    environment: { headRevision: "empty-environment" },
    catalog: { teams: [], projects: [] },
  }) as unknown as WorkspaceBoundary;

const memoryPins = (initial = emptyAccountTrustPins()) => {
  let pins: AccountTrustPins = initial;
  return {
    load: async () => pins,
    save: async (next: AccountTrustPins) => {
      pins = next;
    },
    current: () => pins,
  };
};

describe("browser account trust (ADR 0015)", () => {
  test("drops an own Device and a teammate Device the service injected", async () => {
    const ownAmk = randomKey();
    const teammateAmk = randomKey();
    const own = device(ownDeviceId);
    const peer = device(peerDeviceId);
    const injected = device(injectedDeviceId);
    const teammate = device(teammateDeviceId);
    const boundary = boundaryWith(own, [peer, injected], teammate, {
      [ownUserId]: await roster(ownAmk, ownUserId, 1, [own, peer]),
      [teammateId]: await roster(teammateAmk, teammateId, 1, [
        device(teammateDeviceId),
      ]),
    });
    const trusted = await establishBrowserAccountTrust({
      boundary,
      accountMasterKey: ownAmk,
      actor: { origin: "https://relay.example", deviceId: own.deviceId },
      encryptionPublicKey: own.encryptionPublicKey,
      signingPublicKey: own.signingPublicKey,
      pinStore: memoryPins(),
      publish: async () => {
        throw new Error("no roster change is expected");
      },
    });
    expect(trusted.boundary.peerDevices?.map((entry) => entry.id)).toEqual([
      peerDeviceId,
    ]);
    // The teammate's roster lists the Device id with other keys: the
    // service-reported keys are refused.
    expect(
      trusted.boundary.signingTrustDevices?.map((entry) => entry.deviceId),
    ).toEqual([ownDeviceId, peerDeviceId]);
  });

  test("publishes the first roster when the AMK is unlocked", async () => {
    const amk = randomKey();
    const own = device(ownDeviceId);
    const published: Uint8Array[] = [];
    const pins = memoryPins();
    await establishBrowserAccountTrust({
      boundary: boundaryWith(own, [], device(teammateDeviceId), {}),
      accountMasterKey: amk,
      actor: { origin: "https://relay.example", deviceId: own.deviceId },
      encryptionPublicKey: own.encryptionPublicKey,
      signingPublicKey: own.signingPublicKey,
      pinStore: pins,
      publish: async (_actor, entry) => {
        published.push(entry.canonicalBytes);
      },
    });
    expect(published).toHaveLength(1);
    const { identity } = await deriveAccountSigningKey(amk, {
      serverProfileId,
      userId: ownUserId,
    });
    const verified = await verifyAccountDeviceRoster(published[0]!, {
      serverProfileId,
      userId: ownUserId,
      identity,
    });
    expect(verified.devices.map((entry) => entry.deviceId)).toContain(
      ownDeviceId,
    );
    expect(pins.current().own?.rosterVersion).toBe(1);
  });

  test("refuses a roster for this account that the account key did not sign", async () => {
    const own = device(ownDeviceId);
    await expect(
      establishBrowserAccountTrust({
        boundary: boundaryWith(own, [], device(teammateDeviceId), {
          [ownUserId]: await roster(randomKey(), ownUserId, 4, [own]),
        }),
        accountMasterKey: randomKey(),
        actor: null,
        encryptionPublicKey: own.encryptionPublicKey,
        signingPublicKey: own.signingPublicKey,
        pinStore: memoryPins(),
      }),
    ).rejects.toBeInstanceOf(AccountRosterUntrustedError);
  });

  test("unverified Users keep today's behaviour", async () => {
    const own = device(ownDeviceId);
    const teammate = device(teammateDeviceId);
    const boundary = boundaryWith(own, [], teammate, {});
    const resolution = await resolveAccountTrust({
      pins: emptyAccountTrustPins(),
      serverProfileId,
      ownUserId,
      ownIdentity: null,
      rosters: new Map([[teammateId, null]]),
    });
    expect(
      applyBrowserAccountTrust(
        boundary,
        resolution,
        ownUserId,
      ).signingTrustDevices?.map((entry) => entry.deviceId),
    ).toEqual([ownDeviceId, teammateDeviceId]);
  });
});

describe("membership provisioning recipients (ADR 0015)", () => {
  const resolutionFor = async (
    pins: AccountTrustPins,
    rosterText: string | null,
  ) =>
    resolveAccountTrust({
      pins,
      serverProfileId,
      ownUserId,
      ownIdentity: null,
      rosters: new Map([
        [
          teammateId,
          rosterText === null ? null : Buffer.from(rosterText, "base64"),
        ],
      ]),
    });

  test("shares keys only with the member's roster Devices", async () => {
    const amk = randomKey();
    const listed = device(teammateDeviceId);
    const resolution = await resolutionFor(
      emptyAccountTrustPins(),
      await roster(amk, teammateId, 1, [listed]),
    );
    expect(
      assertProvisioningRecipients(resolution, teammateId, [
        {
          id: listed.deviceId,
          encryptionPublicKey: hex(listed.encryptionPublicKey),
        },
      ]),
    ).toBe("verified");
    expect(() =>
      assertProvisioningRecipients(resolution, teammateId, [
        {
          id: listed.deviceId,
          encryptionPublicKey: hex(listed.encryptionPublicKey),
        },
        { id: injectedDeviceId, encryptionPublicKey: hex(randomKey()) },
      ]),
    ).toThrow(ProvisioningRecipientError);
    // The listed Device id with a swapped encryption key is refused too.
    expect(() =>
      assertProvisioningRecipients(resolution, teammateId, [
        { id: listed.deviceId, encryptionPublicKey: hex(randomKey()) },
      ]),
    ).toThrow(ProvisioningRecipientError);
  });

  test("a swapped member account key blocks provisioning", async () => {
    const listed = device(teammateDeviceId);
    const pinned = (
      await resolutionFor(
        emptyAccountTrustPins(),
        await roster(randomKey(), teammateId, 1, [listed]),
      )
    ).pins;
    const swapped = await resolutionFor(
      pinned,
      await roster(randomKey(), teammateId, 2, [listed]),
    );
    expect(() =>
      assertProvisioningRecipients(swapped, teammateId, [
        {
          id: listed.deviceId,
          encryptionPublicKey: hex(listed.encryptionPublicKey),
        },
      ]),
    ).toThrow("account key changed");
  });
});
