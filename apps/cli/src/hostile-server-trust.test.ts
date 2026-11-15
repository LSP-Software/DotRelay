import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAccountDeviceRoster,
  createMemoryCredentialStore,
  createProjectEpochGrantBootstrap,
  createPublicationArtifacts,
  type DeviceKeyMaterial,
  deriveAccountSigningKey,
  emptyAccountTrustPins,
  openProjectEpochGrant,
  type RosterDevice,
  resolveAccountTrust,
  verifyAccountDeviceRoster,
  verifySyncPage,
} from "@dotrelay/client";
import {
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  parseProtocolObject,
  type SyncRevisionWire,
  sha384,
} from "@dotrelay/contracts";
import type { StrictJsonClient } from "./admin";
import {
  establishAccountTrust,
  saveAccountTrustPins,
} from "./workflow-account-trust";
import {
  type Boundary,
  bytesToHex,
  collectSigningTrust,
  parseBoundary,
  projectGrantVerification,
  type WorkflowOptions,
} from "./workflow-core";
import { wrapEpochKeyToPeers } from "./workflow-epoch-grants";

// Regression tests for the account-trust cases of the November 2026
// internal review. The Server Profile is the adversary: it shapes the
// workspace boundary to make a client trust or key a Device it controls.

const serverProfileId = "11111111-1111-4111-8111-111111111111";
const ids = {
  user: "22222222-2222-4222-8222-222222222222",
  device: "33333333-3333-4333-8333-333333333333",
  team: "44444444-4444-4444-8444-444444444444",
  project: "55555555-5555-4555-8555-555555555555",
  environment: "66666666-6666-4666-8666-666666666666",
  teammate: "77777777-7777-4777-8777-777777777777",
  teammateDevice: "88888888-8888-4888-8888-888888888888",
  injected: "99999999-9999-4999-8999-999999999999",
};

const raw = async (key: CryptoKey | undefined): Promise<Uint8Array> => {
  if (!key) throw new Error("public key is missing");
  return new Uint8Array(await crypto.subtle.exportKey("raw", key));
};

const deviceKeys = async () => {
  const encryption = await generateEncryptionKeyPair();
  const signing = await generateSigningKeyPair();
  const keys: DeviceKeyMaterial = {
    encryptionPrivateKey: encryption.privateKey,
    encryptionPublicKey: encryption.publicKey,
    signingPrivateKey: signing.privateKey,
    signingPublicKey: signing.publicKey,
  };
  return {
    keys,
    encryptionPublicKey: await raw(encryption.publicKey),
    signingPublicKey: await raw(signing.publicKey),
  };
};

const rosterDevice = (
  deviceId: string,
  device: Awaited<ReturnType<typeof deviceKeys>>,
): RosterDevice => ({
  deviceId,
  encryptionPublicKey: device.encryptionPublicKey,
  signingPublicKey: device.signingPublicKey,
  addedAtMs: 1,
});

const signedRoster = async (
  amk: Uint8Array,
  userId: string,
  version: number,
  devices: readonly RosterDevice[],
): Promise<Uint8Array> =>
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

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const optionsWith = async (
  input: Readonly<{
    readonly postedRosters: Uint8Array[];
    readonly postedGrants: Uint8Array[];
  }>,
): Promise<WorkflowOptions> => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "dotrelay-hostile-"));
  directories.push(stateDirectory);
  const admin: StrictJsonClient = {
    get: async () => {
      throw new Error("unexpected read");
    },
    post: async (path, body) => {
      if (path === "/api/v1/account-keys/rosters") {
        input.postedRosters.push(
          new Uint8Array(Buffer.from(String(body.object), "base64")),
        );
        return { objectId: body.objectId, idempotent: false };
      }
      throw new Error(`unexpected write to ${path}`);
    },
  };
  return {
    profile: {
      name: "relay",
      origin: "https://relay.example",
      pin: { origin: "https://relay.example", serverProfileId },
    },
    credentials: createMemoryCredentialStore(),
    stateDirectory,
    contextPath: join(stateDirectory, "context.json"),
    noInput: true,
    force: false,
    stdoutIsTerminal: false,
    admin,
    fetch: async (request, init) => {
      const url = new URL(
        request instanceof Request ? request.url : String(request),
      );
      if (url.pathname === "/api/v1/grants/bootstrap") {
        const body = JSON.parse(String(init?.body)) as { grant: string };
        input.postedGrants.push(
          new Uint8Array(Buffer.from(body.grant, "base64")),
        );
        return Response.json(
          { grantObjectId: crypto.randomUUID(), idempotent: false },
          { status: 201 },
        );
      }
      throw new Error(`unexpected request to ${url.pathname}`);
    },
  };
};

const boundaryWith = (fields: Record<string, unknown>): Boundary =>
  parseBoundary({
    session: { active: true, userId: ids.user },
    environment: {
      id: ids.environment,
      projectId: ids.project,
      teamId: ids.team,
      headRevision: "empty-environment",
      headHash: null,
      projectEpoch: "1",
    },
    device: { active: true, id: ids.device },
    grantsReady: true,
    epochCurrent: true,
    crypto: { available: true },
    ...fields,
  });

describe("C-1: a fresh installation never trusts Devices from a withheld roster", () => {
  test("publishes a roster of itself only and seals the Project key to no injected peer", async () => {
    const own = await deviceKeys();
    const injected = await deviceKeys();
    const amk = crypto.getRandomValues(new Uint8Array(32));
    const postedRosters: Uint8Array[] = [];
    const postedGrants: Uint8Array[] = [];
    const options = await optionsWith({ postedRosters, postedGrants });
    // The service withholds this User's roster and reports one extra peer
    // Device whose keys it holds, as one that still lacks the Project key.
    const boundary = boundaryWith({
      accountRosters: { [ids.user]: null },
      peerDevices: [
        {
          id: ids.injected,
          encryptionPublicKey: bytesToHex(injected.encryptionPublicKey),
          signingPublicKey: bytesToHex(injected.signingPublicKey),
          hasEpochGrant: false,
        },
      ],
    });
    const outcome = await establishAccountTrust({
      options,
      boundary,
      userId: ids.user,
      deviceId: ids.device,
      accountMasterKey: amk,
      encryptionPublicKey: own.encryptionPublicKey,
      signingPublicKey: own.signingPublicKey,
    });
    // The first roster this installation signs lists only itself.
    expect(postedRosters).toHaveLength(1);
    const { identity } = await deriveAccountSigningKey(amk, {
      serverProfileId,
      userId: ids.user,
    });
    const roster = await verifyAccountDeviceRoster(postedRosters[0]!, {
      serverProfileId,
      userId: ids.user,
      identity,
    });
    expect(roster.devices.map((device) => device.deviceId)).toEqual([
      ids.device,
    ]);
    expect(outcome.boundary.peerDevices.map((peer) => peer.id)).not.toContain(
      ids.injected,
    );
    // No Project Epoch Key reaches the injected Device.
    const epochKey = crypto.getRandomValues(new Uint8Array(32));
    await wrapEpochKeyToPeers(
      options,
      "session-token",
      outcome.boundary,
      ids.device,
      own.keys,
      epochKey,
    );
    expect(postedGrants).toHaveLength(0);
  });

  test("a locked installation trusts none of its own peers without a pinned roster", async () => {
    const own = await deviceKeys();
    const injected = await deviceKeys();
    const postedRosters: Uint8Array[] = [];
    const postedGrants: Uint8Array[] = [];
    const options = await optionsWith({ postedRosters, postedGrants });
    const outcome = await establishAccountTrust({
      options,
      boundary: boundaryWith({
        accountRosters: { [ids.user]: null },
        peerDevices: [
          {
            id: ids.injected,
            encryptionPublicKey: bytesToHex(injected.encryptionPublicKey),
            signingPublicKey: bytesToHex(injected.signingPublicKey),
            hasEpochGrant: false,
          },
        ],
        signingTrustKeys: [bytesToHex(injected.signingPublicKey)],
      }),
      userId: ids.user,
      deviceId: ids.device,
      accountMasterKey: null,
      encryptionPublicKey: own.encryptionPublicKey,
      signingPublicKey: own.signingPublicKey,
    });
    expect(postedRosters).toHaveLength(0);
    expect(outcome.boundary.peerDevices).toHaveLength(0);
    expect(outcome.boundary.signingTrustKeys).toHaveLength(0);
  });
});

describe("C-2: a teammate the service leaves out of the rosters is not trusted", () => {
  // An installation with its own identity pinned at version 1 and teammate
  // Z confirmed at version 2.
  const pinned = async () => {
    const own = await deviceKeys();
    const teammate = await deviceKeys();
    const injected = await deviceKeys();
    const ownAmk = crypto.getRandomValues(new Uint8Array(32));
    const teammateAmk = crypto.getRandomValues(new Uint8Array(32));
    const ownRoster = await signedRoster(ownAmk, ids.user, 1, [
      rosterDevice(ids.device, own),
    ]);
    const teammateRoster = await signedRoster(teammateAmk, ids.teammate, 2, [
      rosterDevice(ids.teammateDevice, teammate),
    ]);
    const postedRosters: Uint8Array[] = [];
    const postedGrants: Uint8Array[] = [];
    const options = await optionsWith({ postedRosters, postedGrants });
    const resolution = await resolveAccountTrust({
      pins: emptyAccountTrustPins(),
      serverProfileId,
      ownUserId: ids.user,
      ownIdentity: (
        await deriveAccountSigningKey(ownAmk, {
          serverProfileId,
          userId: ids.user,
        })
      ).identity,
      rosters: new Map([
        [ids.user, ownRoster],
        [ids.teammate, teammateRoster],
      ]),
    });
    const teammatePin = resolution.pins.teammates[ids.teammate];
    if (!teammatePin) throw new Error("teammate was not pinned");
    await saveAccountTrustPins(options, {
      ...resolution.pins,
      teammates: {
        ...resolution.pins.teammates,
        [ids.teammate]: { ...teammatePin, confirmed: true },
      },
    });
    // Z is omitted from accountRosters; a Device the service controls is
    // listed under Z.
    const boundary = boundaryWith({
      accountRosters: { [ids.user]: Buffer.from(ownRoster).toString("base64") },
      signingTrustDevices: [
        {
          deviceId: ids.injected,
          userId: ids.teammate,
          signingPublicKey: bytesToHex(injected.signingPublicKey),
          encryptionPublicKey: bytesToHex(injected.encryptionPublicKey),
          deviceActiveFromMs: 0,
          deviceActiveUntilMs: null,
          memberSinceMs: 0,
          memberUntilMs: null,
        },
      ],
      signingTrustKeys: [bytesToHex(injected.signingPublicKey)],
    });
    const outcome = await establishAccountTrust({
      options,
      boundary,
      userId: ids.user,
      deviceId: ids.device,
      accountMasterKey: ownAmk,
      encryptionPublicKey: own.encryptionPublicKey,
      signingPublicKey: own.signingPublicKey,
    });
    return { own, injected, outcome };
  };

  test("drops the injected Device and refuses a grant it signed", async () => {
    const { own, injected, outcome } = await pinned();
    expect(
      outcome.boundary.signingTrustDevices.map((device) => device.deviceId),
    ).not.toContain(ids.injected);
    expect(outcome.resolution.users.get(ids.teammate)?.status).toBe("rollback");
    const chosenKey = crypto.getRandomValues(new Uint8Array(32));
    const grant = await createProjectEpochGrantBootstrap({
      serverProfileId,
      teamId: ids.team,
      projectId: ids.project,
      projectEpoch: 1,
      senderDeviceId: ids.injected,
      recipientDeviceId: ids.device,
      recipientX25519PublicKey: own.encryptionPublicKey,
      recipientEncryptionPublicKey: own.keys.encryptionPublicKey!,
      signingPrivateKey: injected.keys.signingPrivateKey,
      plaintextKey: chosenKey,
    });
    await expect(
      openProjectEpochGrant(
        grant.canonicalBytes,
        own.keys.encryptionPrivateKey,
        projectGrantVerification(
          outcome.boundary,
          ids.device,
          serverProfileId,
          own.signingPublicKey,
        ),
      ),
    ).rejects.toThrow();
  });

  test("refuses a Revision the injected Device signed", async () => {
    const { own, injected, outcome } = await pinned();
    const chosenKey = crypto.getRandomValues(new Uint8Array(32));
    const artifacts = await createPublicationArtifacts(
      [
        {
          id: "abababab-abab-4bab-8bab-abababababab",
          name: "DATABASE_URL",
          description: "",
          ownership: "SHARED_VALUE",
          value: "postgres://attacker.example/db",
          required: true,
          hasDraftChange: true,
        },
      ],
      {
        serverProfileId,
        teamId: ids.team,
        projectId: ids.project,
        environmentId: ids.environment,
        actorUserId: ids.teammate,
        actorDeviceId: ids.injected,
        projectEpoch: 1,
        expectedHeadId: null,
        expectedHeadHash: null,
        valueRecipientPublicKey: injected.keys.encryptionPublicKey!,
        sharedValueSecret: chosenKey,
        signingPrivateKey: injected.keys.signingPrivateKey,
        mutation: "GENESIS",
      },
    );
    const revisionObject = artifacts.stagedObjects.find(
      (object) =>
        object.objectId === artifacts.request.revision.protocolObjectId,
    );
    if (!revisionObject) throw new Error("revision object is missing");
    const parsed = parseProtocolObject(revisionObject.bytes);
    const revision: SyncRevisionWire = {
      id: artifacts.request.revision.id,
      digest: await sha384(revisionObject.bytes),
      parentId: ids.environment,
      parentHash: new Uint8Array(48),
      mutation: parsed.get(35) as number,
      projectEpoch: 1n,
      authoredAtMs: BigInt(parsed.get(34) as number),
      rollbackTargetId: null,
      objects: await Promise.all(
        artifacts.stagedObjects.map(async (object) => ({
          objectId: object.objectId,
          canonicalBytes: object.bytes,
          digest: await sha384(object.bytes),
        })),
      ),
    };
    await expect(
      verifySyncPage(
        {
          environmentId: ids.environment,
          trustedRevisionId: ids.environment,
          trustedRevisionHash: new Uint8Array(48),
          currentHeadId: revision.id,
          currentHeadHash: revision.digest,
          projectEpoch: 1n,
          revisions: [revision],
          nextCursor: null,
        },
        collectSigningTrust(outcome.boundary, own.signingPublicKey),
        {
          actorUserId: ids.user,
          expectedTrustedRevisionId: ids.environment,
          expectedTrustedRevisionHash: new Uint8Array(48),
        },
      ),
    ).rejects.toThrow();
  });
});
