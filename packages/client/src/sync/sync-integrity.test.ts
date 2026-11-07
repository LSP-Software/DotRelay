import { describe, expect, test } from "bun:test";
import {
  exportSigningPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  parseProtocolObject,
  type SyncPageWire,
  type SyncRevisionWire,
  sha384,
} from "@dotrelay/contracts";
import { ProtocolVerificationError } from "../trust/verify";
import { createEpochRotationArtifacts } from "./epoch-rotation";
import {
  createPublicationArtifacts,
  decodeSyncVariables,
  MAX_REVISION_CLOCK_SKEW_MS,
  type PublicationVariable,
  type StagedPublicationObject,
  UnreadableLaneError,
  verifySyncPage,
} from "./publication";
import { createVerifiedEnvironmentSession } from "./session";
import type { ProtocolTransport } from "./transport";

const ids = {
  serverProfileId: "11111111-1111-4111-8111-111111111111",
  teamId: "22222222-2222-4222-8222-222222222222",
  projectId: "33333333-3333-4333-8333-333333333333",
  environmentId: "44444444-4444-4444-8444-444444444444",
  actorUserId: "55555555-5555-4555-8555-555555555555",
  actorDeviceId: "66666666-6666-4666-8666-666666666666",
};
const genesisHash = new Uint8Array(48);
const fromGenesis = {
  expectedTrustedRevisionId: ids.environmentId,
  expectedTrustedRevisionHash: genesisHash,
} as const;

const sharedVariable = (id: string, name: string): PublicationVariable => ({
  id,
  name,
  description: "",
  ownership: "SHARED_VALUE",
  value: `secret-${name}`,
  required: true,
  hasDraftChange: true,
});

// The sync wire form of one staged Revision, chained to its parent.
const syncRevision = async (
  staged: readonly StagedPublicationObject[],
  revisionObjectId: string,
  revisionId: string,
  parent: Readonly<{ id: string; digest: Uint8Array }>,
): Promise<SyncRevisionWire> => {
  const object = staged.find(
    (candidate) => candidate.objectId === revisionObjectId,
  );
  if (!object) throw new Error("revision object is missing");
  const revision = parseProtocolObject(object.bytes);
  return {
    id: revisionId,
    digest: await sha384(object.bytes),
    parentId: parent.id,
    parentHash: parent.digest,
    mutation: revision.get(35) as number,
    projectEpoch: BigInt(revision.get(30) as number),
    authoredAtMs: BigInt(revision.get(34) as number),
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

const page = (
  trusted: Readonly<{ id: string; digest: Uint8Array }>,
  revisions: readonly SyncRevisionWire[],
): SyncPageWire => {
  const head = revisions.at(-1);
  return {
    environmentId: ids.environmentId,
    trustedRevisionId: trusted.id,
    trustedRevisionHash: trusted.digest,
    currentHeadId: head?.id ?? null,
    currentHeadHash: head?.digest ?? null,
    projectEpoch: head?.projectEpoch ?? 1n,
    revisions,
    nextCursor: null,
  };
};

const genesis = { id: ids.environmentId, digest: genesisHash };

const setup = async () => {
  const signing = await generateSigningKeyPair();
  const encryption = await generateEncryptionKeyPair();
  const base = {
    ...ids,
    projectEpoch: 1,
    valueRecipientPublicKey: encryption.publicKey,
    signingPrivateKey: signing.privateKey,
  };
  return {
    signing,
    encryption,
    base,
    signingPublicKey: await exportSigningPublicKey(signing.publicKey),
  };
};

describe("sync starting point", () => {
  test("rejects a page that answers a genesis sync from a later Revision", async () => {
    const { encryption, base, signingPublicKey } = await setup();
    const first = await createPublicationArtifacts(
      [sharedVariable("77777777-7777-4777-8777-777777777777", "A")],
      {
        ...base,
        mutation: "GENESIS",
        expectedHeadId: null,
        expectedHeadHash: null,
      },
    );
    const revisionA = await syncRevision(
      first.stagedObjects,
      first.request.revision.protocolObjectId,
      first.request.revision.id,
      genesis,
    );
    const second = await createPublicationArtifacts(
      [sharedVariable("88888888-8888-4888-8888-888888888888", "B")],
      {
        ...base,
        mutation: "MANIFEST_UPDATE",
        expectedHeadId: revisionA.id,
        expectedHeadHash: revisionA.digest,
      },
    );
    const revisionB = await syncRevision(
      second.stagedObjects,
      second.request.revision.protocolObjectId,
      second.request.revision.id,
      revisionA,
    );
    // This Device asked for the whole history; the service answers from A,
    // which hides Variable A.
    const shifted = page(revisionA, [revisionB]);
    await expect(
      verifySyncPage(shifted, signingPublicKey, fromGenesis),
    ).rejects.toThrow("does not start from the requested trusted revision");
    // The complete history verifies and decodes both Variables.
    const complete = page(genesis, [revisionA, revisionB]);
    await verifySyncPage(complete, signingPublicKey, fromGenesis);
    expect(
      (await decodeSyncVariables(complete, () => encryption.privateKey))
        .map((variable) => variable.name)
        .sort(),
    ).toEqual(["A", "B"]);
  });

  test("fails a decode whose Value lane has no known Variable definition", async () => {
    const { encryption, base } = await setup();
    const variableId = "77777777-7777-4777-8777-777777777777";
    const first = await createPublicationArtifacts(
      [sharedVariable(variableId, "A")],
      {
        ...base,
        mutation: "GENESIS",
        expectedHeadId: null,
        expectedHeadHash: null,
      },
    );
    const revisionA = await syncRevision(
      first.stagedObjects,
      first.request.revision.protocolObjectId,
      first.request.revision.id,
      genesis,
    );
    // A Rollback re-publishes only the Value lane, never the definition.
    const rollback = await createPublicationArtifacts(
      [{ ...sharedVariable(variableId, "A"), value: "rolled-back" }],
      {
        ...base,
        mutation: "ROLLBACK",
        rollbackTargetId: revisionA.id,
        rollbackSelectedVariableIds: [variableId],
        expectedHeadId: revisionA.id,
        expectedHeadHash: revisionA.digest,
      },
    );
    const revisionB = await syncRevision(
      rollback.stagedObjects,
      rollback.request.revision.protocolObjectId,
      rollback.request.revision.id,
      revisionA,
    );
    // Decoded without Variable A's definition, the lane must not be skipped.
    await expect(
      decodeSyncVariables(
        page(revisionA, [revisionB]),
        () => encryption.privateKey,
      ),
    ).rejects.toThrow("sync Value lane has no known Variable definition");
    const decoded = await decodeSyncVariables(
      page(genesis, [revisionA, revisionB]),
      () => encryption.privateKey,
    );
    expect(decoded.map((variable) => variable.value)).toEqual(["rolled-back"]);
  });

  test("the verified session checks the page against the requested starting point", async () => {
    const { encryption, base, signingPublicKey } = await setup();
    const artifacts = await createPublicationArtifacts(
      [sharedVariable("77777777-7777-4777-8777-777777777777", "A")],
      {
        ...base,
        mutation: "GENESIS",
        expectedHeadId: null,
        expectedHeadHash: null,
      },
    );
    const revision = await syncRevision(
      artifacts.stagedObjects,
      artifacts.request.revision.protocolObjectId,
      artifacts.request.revision.id,
      genesis,
    );
    const answered = page(genesis, [revision]);
    const session = createVerifiedEnvironmentSession({
      context: {
        ...base,
        expectedHeadId: null,
        expectedHeadHash: null,
        revisionSigningPublicKey: signingPublicKey,
      },
      transport: {
        syncAll: async () => answered,
      } as unknown as ProtocolTransport,
      sharedValuePrivateKey: encryption.privateKey,
    });
    await expect(
      session.syncAndDecode({
        environmentId: ids.environmentId,
        deviceId: ids.actorDeviceId,
        request: {
          trustedRevisionId: revision.id,
          trustedRevisionHash: revision.digest,
          pagination: {},
        },
      }),
    ).rejects.toBeInstanceOf(ProtocolVerificationError);
    const synced = await session.syncAndDecode({
      environmentId: ids.environmentId,
      deviceId: ids.actorDeviceId,
      request: {
        trustedRevisionId: ids.environmentId,
        trustedRevisionHash: genesisHash,
        pagination: {},
      },
    });
    expect(synced.variables.map((variable) => variable.name)).toEqual(["A"]);
  });
});

describe("Project epoch key ring", () => {
  const rotatedHistory = async () => {
    const { encryption, base, signing, signingPublicKey } = await setup();
    const epochOneKey = crypto.getRandomValues(new Uint8Array(32));
    const epochTwoKey = crypto.getRandomValues(new Uint8Array(32));
    const first = await createPublicationArtifacts(
      [sharedVariable("77777777-7777-4777-8777-777777777777", "A")],
      {
        ...base,
        sharedValueSecret: epochOneKey,
        mutation: "GENESIS",
        expectedHeadId: null,
        expectedHeadHash: null,
      },
    );
    const revisionA = await syncRevision(
      first.stagedObjects,
      first.request.revision.protocolObjectId,
      first.request.revision.id,
      genesis,
    );
    const rotation = await createEpochRotationArtifacts({
      ...ids,
      expectedEpoch: 1,
      environments: [
        {
          environmentId: ids.environmentId,
          expectedHeadId: revisionA.id,
          expectedHeadHash: revisionA.digest,
        },
      ],
      signingPrivateKey: signing.privateKey,
      previousEpochKey: new Uint8Array(32).fill(7),
    });
    const transition = rotation.request.transitions[0];
    if (!transition) throw new Error("transition is missing");
    const revisionB = await syncRevision(
      rotation.stagedObjects.filter(
        (object) =>
          object.objectId !== transition.protocolObjectId &&
          object.objectId !== rotation.request.keyLink.protocolObjectId,
      ),
      transition.publication.revision.protocolObjectId,
      transition.newHeadId,
      revisionA,
    );
    const rotated = page(genesis, [revisionA, revisionB]);
    await verifySyncPage(rotated, signingPublicKey, fromGenesis);
    // A probe key stands in for a Device that holds only the epoch keys.
    const probe = await generateEncryptionKeyPair();
    return {
      rotated,
      epochOneKey,
      epochTwoKey,
      probe,
      encryption,
      base,
      signingPublicKey,
    };
  };

  test("reads Shared Values sealed before a rotation with the earlier epoch's key", async () => {
    const { rotated, epochOneKey, epochTwoKey, probe } = await rotatedHistory();
    // Only the current epoch's key: the earlier lanes are unreadable.
    await expect(
      decodeSyncVariables(rotated, () => probe.privateKey, [], epochTwoKey),
    ).rejects.toBeInstanceOf(UnreadableLaneError);
    const ring = new Map([
      [1, epochOneKey],
      [2, epochTwoKey],
    ]);
    const decoded = await decodeSyncVariables(
      rotated,
      () => probe.privateKey,
      [],
      ring,
    );
    expect(decoded.map((variable) => variable.value)).toEqual(["secret-A"]);
    // A key filed under the wrong epoch does not open the lane.
    await expect(
      decodeSyncVariables(
        rotated,
        () => probe.privateKey,
        [],
        new Map([[2, epochOneKey]]),
      ),
    ).rejects.toBeInstanceOf(UnreadableLaneError);
  });

  test("the verified session merges the current key into its key ring", async () => {
    const { rotated, epochOneKey, epochTwoKey, probe, base, signingPublicKey } =
      await rotatedHistory();
    const session = createVerifiedEnvironmentSession({
      context: {
        ...base,
        projectEpoch: 2,
        expectedHeadId: null,
        expectedHeadHash: null,
        revisionSigningPublicKey: signingPublicKey,
      },
      transport: {} as ProtocolTransport,
      sharedValuePrivateKey: probe.privateKey,
      sharedValueSecret: epochTwoKey,
      sharedValueKeyRing: new Map([[1, epochOneKey]]),
    });
    const decoded = await session.decodeVariables(rotated, []);
    expect(decoded.map((variable) => variable.value)).toEqual(["secret-A"]);
  });

  test("rejects a lane sealed under an epoch later than its Revision's", async () => {
    const { rotated, epochOneKey } = await rotatedHistory();
    const [revisionA, revisionB] = rotated.revisions;
    if (!revisionA || !revisionB) throw new Error("revisions are missing");
    // Claim Revision A's lanes (epoch 1) belong to an epoch-0 Revision.
    const tampered = page(genesis, [
      { ...revisionA, projectEpoch: 0n },
      revisionB,
    ]);
    const probe = await generateEncryptionKeyPair();
    await expect(
      decodeSyncVariables(tampered, () => probe.privateKey, [], epochOneKey),
    ).rejects.toThrow("sync lane Project epoch is later than its Revision's");
    // verifySyncPage first rejects the Revision's own mismatched epoch.
    await expect(
      verifySyncPage(
        tampered,
        await exportSigningPublicKey(
          (await generateSigningKeyPair()).publicKey,
        ),
        fromGenesis,
      ),
    ).rejects.toBeInstanceOf(ProtocolVerificationError);
  });
});

describe("Revision authored-at bounds", () => {
  const twoRevisions = async (
    rotationAuthoredAtMs: (parent: bigint) => number,
  ) => {
    const { base, signing, signingPublicKey } = await setup();
    const first = await createPublicationArtifacts(
      [sharedVariable("77777777-7777-4777-8777-777777777777", "A")],
      {
        ...base,
        mutation: "GENESIS",
        expectedHeadId: null,
        expectedHeadHash: null,
      },
    );
    const revisionA = await syncRevision(
      first.stagedObjects,
      first.request.revision.protocolObjectId,
      first.request.revision.id,
      genesis,
    );
    const rotation = await createEpochRotationArtifacts({
      ...ids,
      expectedEpoch: 1,
      environments: [
        {
          environmentId: ids.environmentId,
          expectedHeadId: revisionA.id,
          expectedHeadHash: revisionA.digest,
        },
      ],
      signingPrivateKey: signing.privateKey,
      previousEpochKey: new Uint8Array(32).fill(7),
      authoredAtMs: rotationAuthoredAtMs(revisionA.authoredAtMs),
    });
    const transition = rotation.request.transitions[0];
    if (!transition) throw new Error("transition is missing");
    const revisionB = await syncRevision(
      rotation.stagedObjects.filter(
        (object) =>
          object.objectId !== transition.protocolObjectId &&
          object.objectId !== rotation.request.keyLink.protocolObjectId,
      ),
      transition.publication.revision.protocolObjectId,
      transition.newHeadId,
      revisionA,
    );
    return {
      synced: page(genesis, [revisionA, revisionB]),
      revisionA,
      revisionB,
      signingPublicKey,
    };
  };

  test("rejects a Revision authored before its parent", async () => {
    const { synced, signingPublicKey } = await twoRevisions(
      (parent) => Number(parent) - 60_000,
    );
    await expect(
      verifySyncPage(synced, signingPublicKey, fromGenesis),
    ).rejects.toThrow("authored-at instant is outside its allowed range");
  });

  test("rejects a first Revision authored before the trusted starting point", async () => {
    const { revisionA, revisionB, signingPublicKey } = await twoRevisions(
      (parent) => Number(parent) + 1,
    );
    const incremental = page(revisionA, [revisionB]);
    const fromA = {
      expectedTrustedRevisionId: revisionA.id,
      expectedTrustedRevisionHash: revisionA.digest,
    };
    await verifySyncPage(incremental, signingPublicKey, {
      ...fromA,
      trustedRevisionAuthoredAtMs: revisionA.authoredAtMs,
    });
    await expect(
      verifySyncPage(incremental, signingPublicKey, {
        ...fromA,
        trustedRevisionAuthoredAtMs: revisionB.authoredAtMs + 1n,
      }),
    ).rejects.toThrow("authored-at instant is outside its allowed range");
  });

  test("rejects a Revision authored beyond the allowed clock skew", async () => {
    const hourMs = 60 * 60 * 1000;
    const { synced, revisionB, signingPublicKey } = await twoRevisions(
      () => Date.now() + hourMs,
    );
    await expect(
      verifySyncPage(synced, signingPublicKey, fromGenesis),
    ).rejects.toThrow("authored-at instant is outside its allowed range");
    // Within the skew of this Device's clock it is accepted.
    await verifySyncPage(synced, signingPublicKey, {
      ...fromGenesis,
      nowMs: Number(revisionB.authoredAtMs) - MAX_REVISION_CLOCK_SKEW_MS,
    });
    await expect(
      verifySyncPage(synced, signingPublicKey, {
        ...fromGenesis,
        nowMs: Number(revisionB.authoredAtMs) - MAX_REVISION_CLOCK_SKEW_MS - 1,
      }),
    ).rejects.toThrow("authored-at instant is outside its allowed range");
  });
});
