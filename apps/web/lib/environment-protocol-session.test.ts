import { expect, test } from "bun:test";
import {
  createEpochRotationArtifacts,
  createPublicationArtifacts,
  openLane,
  type ProtocolTransport,
  verifySyncPage,
} from "@dotrelay/client";
import {
  exportSigningPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  InvalidCiphertextError,
  parseProtocolObject,
  type SyncPageWire,
  sha384,
} from "@dotrelay/contracts";
import { bytesToHex } from "./account-keys";
import {
  createEnvironmentProtocolSession,
  deviceAuthoredAtNotBeforeMs,
  revisionSigningTrustEntries,
} from "./environment-protocol-session";
import { parseSigningTrustDevices } from "./workspace-boundary";

const ids = {
  serverProfileId: "11111111-1111-4111-8111-111111111111",
  teamId: "22222222-2222-4222-8222-222222222222",
  projectId: "33333333-3333-4333-8333-333333333333",
  environmentId: "44444444-4444-4444-8444-444444444444",
  actorUserId: "55555555-5555-4555-8555-555555555555",
  actorDeviceId: "66666666-6666-4666-8666-666666666666",
};

test("a browser rollback is sealed with the Project epoch key another Device holds", async () => {
  const browser = await generateEncryptionKeyPair();
  const cli = await generateEncryptionKeyPair();
  const signing = await generateSigningKeyPair();
  const epochKey = crypto.getRandomValues(new Uint8Array(32));
  const variableId = "77777777-7777-4777-8777-777777777777";
  // The workspace resolves the epoch key after building the publication
  // context and passes it only as the session read key. Publish must still
  // seal with that key.
  const session = createEnvironmentProtocolSession({
    context: {
      ...ids,
      projectEpoch: 1,
      expectedHeadId: ids.environmentId,
      expectedHeadHash: new Uint8Array(48),
      valueRecipientPublicKey: browser.publicKey,
      userDefinedValueRecipientPublicKey: browser.publicKey,
      signingPrivateKey: signing.privateKey,
      revisionSigningPublicKey: await exportSigningPublicKey(signing.publicKey),
    },
    transport: {} as ProtocolTransport,
    sharedValuePrivateKey: browser.privateKey,
    sharedValueSecret: epochKey,
  });
  const artifacts = await createPublicationArtifacts(
    [
      {
        id: variableId,
        name: "DATABASE_URL",
        description: "Connection string",
        ownership: "SHARED_VALUE",
        value: "postgres://rolled-back",
        required: true,
        hasDraftChange: true,
      },
    ],
    {
      ...session.context,
      mutation: "ROLLBACK",
      rollbackTargetId: ids.environmentId,
      rollbackSelectedVariableIds: [variableId],
    },
  );
  const valueLane = artifacts.stagedObjects.find((staged) => {
    const object = parseProtocolObject(staged.bytes);
    return object.get(1) === 13 && object.get(36) === 3;
  });
  if (!valueLane) throw new Error("rollback value lane is missing");
  await expect(
    openLane(valueLane.bytes, cli.privateKey),
  ).rejects.toBeInstanceOf(InvalidCiphertextError);
  expect(
    new TextDecoder().decode(
      await openLane(valueLane.bytes, cli.privateKey, epochKey),
    ),
  ).toBe("postgres://rolled-back");
});

test("a browser session reads Shared Values sealed before a Project epoch rotation", async () => {
  const browser = await generateEncryptionKeyPair();
  const signing = await generateSigningKeyPair();
  const epochOneKey = crypto.getRandomValues(new Uint8Array(32));
  const epochTwoKey = crypto.getRandomValues(new Uint8Array(32));
  const elsewhere = await generateEncryptionKeyPair();
  const published = await createPublicationArtifacts(
    [
      {
        id: "77777777-7777-4777-8777-777777777777",
        name: "DATABASE_URL",
        description: "Connection string",
        ownership: "SHARED_VALUE",
        value: "postgres://before-rotation",
        required: true,
        hasDraftChange: true,
      },
    ],
    {
      ...ids,
      projectEpoch: 1,
      expectedHeadId: null,
      expectedHeadHash: null,
      valueRecipientPublicKey: elsewhere.publicKey,
      sharedValueSecret: epochOneKey,
      signingPrivateKey: signing.privateKey,
      mutation: "GENESIS",
    },
  );
  const wire = async (
    staged: readonly Readonly<{ objectId: string; bytes: Uint8Array }>[],
    revisionObjectId: string,
    id: string,
    parent: Readonly<{ id: string; digest: Uint8Array }>,
  ): Promise<SyncPageWire["revisions"][number]> => {
    const object = staged.find(
      (candidate) => candidate.objectId === revisionObjectId,
    );
    if (!object) throw new Error("revision object is missing");
    const parsed = parseProtocolObject(object.bytes);
    return {
      id,
      digest: await sha384(object.bytes),
      parentId: parent.id,
      parentHash: parent.digest,
      mutation: parsed.get(35) as number,
      projectEpoch: BigInt(parsed.get(30) as number),
      authoredAtMs: BigInt(parsed.get(34) as number),
      rollbackTargetId: null,
      objects: await Promise.all(
        staged.map(async (candidate) => ({
          objectId: candidate.objectId,
          canonicalBytes: candidate.bytes,
          digest: await sha384(candidate.bytes),
        })),
      ),
    };
  };
  const genesis = await wire(
    published.stagedObjects,
    published.request.revision.protocolObjectId,
    published.request.revision.id,
    { id: ids.environmentId, digest: new Uint8Array(48) },
  );
  const rotation = await createEpochRotationArtifacts({
    ...ids,
    expectedEpoch: 1,
    environments: [
      {
        environmentId: ids.environmentId,
        expectedHeadId: genesis.id,
        expectedHeadHash: genesis.digest,
      },
    ],
    signingPrivateKey: signing.privateKey,
    previousEpochKey: new Uint8Array(32).fill(7),
  });
  const transition = rotation.request.transitions[0];
  if (!transition) throw new Error("transition is missing");
  const rotated = await wire(
    rotation.stagedObjects.filter(
      (object) =>
        object.objectId !== transition.protocolObjectId &&
        object.objectId !== rotation.request.keyLink.protocolObjectId,
    ),
    transition.publication.revision.protocolObjectId,
    transition.newHeadId,
    genesis,
  );
  const page: SyncPageWire = {
    environmentId: ids.environmentId,
    trustedRevisionId: ids.environmentId,
    trustedRevisionHash: new Uint8Array(48),
    currentHeadId: rotated.id,
    currentHeadHash: rotated.digest,
    projectEpoch: 2n,
    revisions: [genesis, rotated],
    nextCursor: null,
  };
  const revisionSigningPublicKey = await exportSigningPublicKey(
    signing.publicKey,
  );
  const session = (keyRing?: ReadonlyMap<number, Uint8Array>) =>
    createEnvironmentProtocolSession({
      context: {
        ...ids,
        projectEpoch: 2,
        expectedHeadId: rotated.id,
        expectedHeadHash: rotated.digest,
        valueRecipientPublicKey: browser.publicKey,
        signingPrivateKey: signing.privateKey,
        revisionSigningPublicKey,
      },
      transport: {} as ProtocolTransport,
      sharedValuePrivateKey: browser.privateKey,
      sharedValueSecret: epochTwoKey,
      ...(keyRing ? { sharedValueKeyRing: keyRing } : {}),
    });
  await expect(session().decodeVariables(page, [])).rejects.toThrow();
  const withRing = session(new Map([[1, epochOneKey]]));
  // New publications still seal with the current epoch's key.
  expect(withRing.context.sharedValueSecret).toEqual(epochTwoKey);
  const decoded = await withRing.decodeVariables(page, []);
  expect(decoded.map((variable) => variable.value)).toEqual([
    "postgres://before-rotation",
  ]);
});

test("a Revision from an earlier Membership period verifies through the boundary's trust entries", async () => {
  const author = await generateSigningKeyPair();
  const encryption = await generateEncryptionKeyPair();
  const day = 24 * 60 * 60 * 1_000;
  const now = Date.now();
  const authoredAtMs = now - 10 * day;
  const removedAtMs = now - 5 * day;
  const rejoinedAtMs = now - day;
  const published = await createPublicationArtifacts(
    [
      {
        id: "77777777-7777-4777-8777-777777777777",
        name: "DATABASE_URL",
        description: "Connection string",
        ownership: "SHARED_VALUE",
        value: "postgres://first-period",
        required: true,
        hasDraftChange: true,
      },
    ],
    {
      ...ids,
      projectEpoch: 1,
      expectedHeadId: null,
      expectedHeadHash: null,
      valueRecipientPublicKey: encryption.publicKey,
      signingPrivateKey: author.privateKey,
      mutation: "GENESIS",
      nowMs: authoredAtMs,
    },
  );
  const revisionObject = published.stagedObjects.find(
    (object) => object.objectId === published.request.revision.protocolObjectId,
  );
  if (!revisionObject) throw new Error("revision object is missing");
  const digest = await sha384(revisionObject.bytes);
  const page: SyncPageWire = {
    environmentId: ids.environmentId,
    trustedRevisionId: ids.environmentId,
    trustedRevisionHash: new Uint8Array(48),
    currentHeadId: published.request.revision.id,
    currentHeadHash: digest,
    projectEpoch: 1n,
    revisions: [
      {
        id: published.request.revision.id,
        digest,
        parentId: ids.environmentId,
        parentHash: new Uint8Array(48),
        mutation: 1,
        projectEpoch: 1n,
        authoredAtMs: BigInt(authoredAtMs),
        rollbackTargetId: null,
        objects: await Promise.all(
          published.stagedObjects.map(async (object) => ({
            objectId: object.objectId,
            canonicalBytes: object.bytes,
            digest: await sha384(object.bytes),
          })),
        ),
      },
    ],
    nextCursor: null,
  };
  // What GET /api/v1/workspace/boundary reports for a Member removed and
  // invited back: memberSinceMs is the current period only.
  const boundaryEntry = {
    deviceId: ids.actorDeviceId,
    userId: ids.actorUserId,
    signingPublicKey: bytesToHex(
      await exportSigningPublicKey(author.publicKey),
    ),
    deviceActiveFromMs: 0,
    deviceActiveUntilMs: null,
    memberSinceMs: rejoinedAtMs,
    memberUntilMs: null,
  };
  const verify = (entry: unknown) =>
    verifySyncPage(
      page,
      revisionSigningTrustEntries(parseSigningTrustDevices([entry])),
      {
        actorUserId: ids.actorUserId,
        expectedTrustedRevisionId: ids.environmentId,
        expectedTrustedRevisionHash: new Uint8Array(48),
      },
    );
  await expect(verify(boundaryEntry)).rejects.toThrow(
    "sync revision signature is not authorized",
  );
  await expect(
    verify({
      ...boundaryEntry,
      membershipPeriods: [
        { sinceMs: authoredAtMs - day, untilMs: removedAtMs },
        { sinceMs: rejoinedAtMs, untilMs: null },
      ],
    }),
  ).resolves.toBeUndefined();
});

test("malformed Membership periods drop the trust entry instead of widening it", () => {
  const entry = {
    signingPublicKey: "aa",
    deviceActiveFromMs: 0,
    deviceActiveUntilMs: null,
    memberSinceMs: 0,
    memberUntilMs: null,
  };
  expect(
    parseSigningTrustDevices([
      { ...entry, membershipPeriods: [{ sinceMs: "0", untilMs: null }] },
      { ...entry, membershipPeriods: "all" },
    ]),
  ).toEqual([]);
  expect(
    parseSigningTrustDevices([
      { ...entry, membershipPeriods: [{ sinceMs: 1, untilMs: 2 }] },
    ])[0]?.membershipPeriods,
  ).toEqual([{ sinceMs: 1, untilMs: 2 }]);
});

test("the authored-at floor comes from this Device's own trust entry", () => {
  const devices = parseSigningTrustDevices([
    {
      deviceId: "other",
      signingPublicKey: "aa",
      deviceActiveFromMs: 9_000,
      deviceActiveUntilMs: null,
      memberSinceMs: 9_000,
      memberUntilMs: null,
    },
    {
      deviceId: ids.actorDeviceId,
      signingPublicKey: "bb",
      deviceActiveFromMs: 2_000,
      deviceActiveUntilMs: null,
      memberSinceMs: 5_000,
      memberUntilMs: null,
    },
  ]);
  expect(deviceAuthoredAtNotBeforeMs(devices, ids.actorDeviceId)).toBe(5_000);
  expect(deviceAuthoredAtNotBeforeMs(devices, "missing")).toBeUndefined();
});
