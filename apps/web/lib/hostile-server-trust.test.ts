import { describe, expect, test } from "bun:test";
import {
  type AccountTrustPins,
  createAccountDeviceRoster,
  createAccountKeyEnvelope,
  createProjectEpochGrantBootstrap,
  deriveAccountSigningKey,
  emptyAccountTrustPins,
  openProjectEpochGrant,
  type RosterDevice,
  resolveAccountTrust,
  uuidToBytes,
  verifyAccountDeviceRoster,
} from "@dotrelay/client";
import {
  encodeProtocolObject,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
} from "@dotrelay/contracts";
import { projectGrantVerification } from "./account-keys";
import { establishBrowserAccountTrust } from "./account-trust";
import { adoptProjectEpochKey } from "./project-key-adoption";
import type { WorkspaceBoundary } from "./workspace-boundary";

// Regression tests for the browser side of the November 2026 internal
// review's account-trust cases: the Server Profile shapes the workspace
// boundary to make the browser trust or key a Device it controls.

const serverProfileId = "11111111-1111-4111-8111-111111111111";
const ownUserId = "22222222-2222-4222-8222-222222222222";
const teammateId = "33333333-3333-4333-8333-333333333333";
const ownDeviceId = "44444444-4444-4444-8444-444444444444";
const injectedDeviceId = "66666666-6666-4666-8666-666666666666";
const teammateDeviceId = "77777777-7777-4777-8777-777777777777";
const teamId = "88888888-8888-4888-8888-888888888888";
const projectId = "99999999-9999-4999-8999-999999999999";

const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");

const realDevice = async (deviceId: string) => {
  const encryption = await generateEncryptionKeyPair();
  const signing = await generateSigningKeyPair();
  const entry: RosterDevice = {
    deviceId,
    encryptionPublicKey: new Uint8Array(
      await crypto.subtle.exportKey("raw", encryption.publicKey),
    ),
    signingPublicKey: new Uint8Array(
      await crypto.subtle.exportKey("raw", signing.publicKey),
    ),
    addedAtMs: 1,
  };
  return { entry, encryption, signing };
};

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

const boundaryOf = (
  own: RosterDevice,
  fields: Partial<WorkspaceBoundary>,
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
    crypto: { available: true },
    environment: {
      headRevision: "empty-environment",
      projectId,
      teamId,
      projectEpoch: "1",
    },
    catalog: { teams: [], projects: [] },
    ...fields,
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

describe("C-1 (browser): a withheld roster never adds a server-chosen Device", () => {
  test("the first roster lists this browser only, and no injected peer is kept", async () => {
    const amk = crypto.getRandomValues(new Uint8Array(32));
    const own = await realDevice(ownDeviceId);
    const injected = await realDevice(injectedDeviceId);
    const published: Uint8Array[] = [];
    const trusted = await establishBrowserAccountTrust({
      boundary: boundaryOf(own.entry, {
        accountRosters: { [ownUserId]: null },
        peerDevices: [
          {
            id: injectedDeviceId,
            encryptionPublicKey: hex(injected.entry.encryptionPublicKey),
            signingPublicKey: hex(injected.entry.signingPublicKey),
            hasEpochGrant: false,
          },
        ],
      }),
      accountMasterKey: amk,
      actor: { origin: "https://relay.example", deviceId: ownDeviceId },
      encryptionPublicKey: own.entry.encryptionPublicKey,
      signingPublicKey: own.entry.signingPublicKey,
      pinStore: memoryPins(),
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
    expect(verified.devices.map((entry) => entry.deviceId)).toEqual([
      ownDeviceId,
    ]);
    expect(trusted.boundary.peerDevices ?? []).toHaveLength(0);
  });
});

describe("C-2 (browser): an omitted pinned teammate vouches for nothing", () => {
  test("drops the injected Device and refuses a grant it signed", async () => {
    const ownAmk = crypto.getRandomValues(new Uint8Array(32));
    const teammateAmk = crypto.getRandomValues(new Uint8Array(32));
    const own = await realDevice(ownDeviceId);
    const teammate = await realDevice(teammateDeviceId);
    const injected = await realDevice(injectedDeviceId);
    const ownRoster = await roster(ownAmk, ownUserId, 1, [own.entry]);
    // Pins with the own identity and teammate Z at version 2, confirmed.
    const resolution = await resolveAccountTrust({
      pins: emptyAccountTrustPins(),
      serverProfileId,
      ownUserId,
      ownIdentity: (
        await deriveAccountSigningKey(ownAmk, {
          serverProfileId,
          userId: ownUserId,
        })
      ).identity,
      rosters: new Map([
        [ownUserId, Buffer.from(ownRoster, "base64")],
        [
          teammateId,
          Buffer.from(
            await roster(teammateAmk, teammateId, 2, [teammate.entry]),
            "base64",
          ),
        ],
      ]),
    });
    const pinned = resolution.pins.teammates[teammateId];
    if (!pinned) throw new Error("teammate was not pinned");
    const pins = memoryPins({
      ...resolution.pins,
      teammates: { [teammateId]: { ...pinned, confirmed: true } },
    });
    const trusted = await establishBrowserAccountTrust({
      boundary: boundaryOf(own.entry, {
        // Z is left out of the rosters; a Device the service holds is
        // listed under Z.
        accountRosters: { [ownUserId]: ownRoster },
        signingTrustDevices: [
          {
            deviceId: injectedDeviceId,
            userId: teammateId,
            signingPublicKey: hex(injected.entry.signingPublicKey),
            encryptionPublicKey: hex(injected.entry.encryptionPublicKey),
            deviceActiveFromMs: 0,
            deviceActiveUntilMs: null,
            memberSinceMs: 0,
            memberUntilMs: null,
          },
        ],
        signingTrustKeys: [hex(injected.entry.signingPublicKey)],
      }),
      accountMasterKey: ownAmk,
      actor: { origin: "https://relay.example", deviceId: ownDeviceId },
      encryptionPublicKey: own.entry.encryptionPublicKey,
      signingPublicKey: own.entry.signingPublicKey,
      pinStore: pins,
      publish: async () => {
        throw new Error("no roster change is expected");
      },
    });
    expect(
      (trusted.boundary.signingTrustDevices ?? []).map(
        (entry) => entry.deviceId,
      ),
    ).not.toContain(injectedDeviceId);
    expect(trusted.resolution.users.get(teammateId)?.status).toBe("rollback");
    const grant = await createProjectEpochGrantBootstrap({
      serverProfileId,
      teamId,
      projectId,
      projectEpoch: 1,
      senderDeviceId: injectedDeviceId,
      recipientDeviceId: ownDeviceId,
      recipientX25519PublicKey: own.entry.encryptionPublicKey,
      recipientEncryptionPublicKey: own.encryption.publicKey,
      signingPrivateKey: injected.signing.privateKey,
      plaintextKey: crypto.getRandomValues(new Uint8Array(32)),
    });
    await expect(
      openProjectEpochGrant(
        grant.canonicalBytes,
        own.encryption.privateKey,
        projectGrantVerification(trusted.boundary),
      ),
    ).rejects.toThrow();
  });

  test("the account's own envelope wins over a grant, and a pinned key cannot be swapped", async () => {
    const amk = crypto.getRandomValues(new Uint8Array(32));
    const own = await realDevice(ownDeviceId);
    const realKey = crypto.getRandomValues(new Uint8Array(32));
    const chosenKey = crypto.getRandomValues(new Uint8Array(32));
    const envelope = Buffer.from(
      encodeProtocolObject(
        (
          await createAccountKeyEnvelope({
            serverProfileId,
            userId: uuidToBytes(ownUserId),
            deviceId: uuidToBytes(ownDeviceId),
            createdAtMs: Date.now(),
            accountMasterKey: amk,
            signingPrivateKey: own.signing.privateKey,
            kind: {
              type: "projectEpochKey",
              projectId: uuidToBytes(projectId),
              projectEpoch: 1,
              contentKey: realKey,
            },
          })
        ).object,
      ),
    ).toString("base64");
    // A grant the browser's own Device signed, carrying another key: the
    // signature is fine, the key is not the account's.
    const grant = Buffer.from(
      (
        await createProjectEpochGrantBootstrap({
          serverProfileId,
          teamId,
          projectId,
          projectEpoch: 1,
          senderDeviceId: ownDeviceId,
          recipientDeviceId: ownDeviceId,
          recipientX25519PublicKey: own.entry.encryptionPublicKey,
          recipientEncryptionPublicKey: own.encryption.publicKey,
          signingPrivateKey: own.signing.privateKey,
          plaintextKey: chosenKey,
        })
      ).canonicalBytes,
    ).toString("base64");
    const boundary = boundaryOf(own.entry, {
      accountKeyEnvelope: envelope,
      epochGrant: grant,
    });
    const pins = memoryPins();
    const adopted = await adoptProjectEpochKey({
      boundary,
      accountMasterKey: amk,
      encryptionPrivateKey: own.encryption.privateKey,
      wrappers: [],
      pinStore: pins,
    });
    expect(adopted).toEqual(realKey);
    // The envelope disappears and only the grant is served: the key this
    // browser pinned for epoch 1 refuses the swap.
    await expect(
      adoptProjectEpochKey({
        boundary: boundaryOf(own.entry, { epochGrant: grant }),
        accountMasterKey: amk,
        encryptionPrivateKey: own.encryption.privateKey,
        wrappers: [],
        pinStore: pins,
      }),
    ).rejects.toThrow("differs");
  });
});
