import { describe, expect, test } from "bun:test";
import {
  exportSigningPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  parseProtocolObject,
  sha384,
  uuidToBytes,
  validateProtocolObject,
} from "@dotrelay/contracts";
import {
  createPublicationArtifacts,
  decodeSyncVariables,
  openLane,
  type PublicationVariable,
  reviewPublication,
  verifySyncPage,
} from "./publication";

const ids = {
  serverProfileId: "11111111-1111-4111-8111-111111111111",
  teamId: "22222222-2222-4222-8222-222222222222",
  projectId: "33333333-3333-4333-8333-333333333333",
  environmentId: "44444444-4444-4444-8444-444444444444",
  actorUserId: "55555555-5555-4555-8555-555555555555",
  actorDeviceId: "66666666-6666-4666-8666-666666666666",
};

const variable = (
  overrides: Partial<PublicationVariable> = {},
): PublicationVariable => ({
  id: "77777777-7777-4777-8777-777777777777",
  name: "DATABASE_URL",
  description: "Connection string",
  ownership: "SHARED_VALUE",
  value: "postgres://example",
  required: true,
  hasDraftChange: true,
  ...overrides,
});

const syncPageFor = async (
  artifacts: Awaited<ReturnType<typeof createPublicationArtifacts>>,
) => {
  const revisionObject = artifacts.stagedObjects.find(
    (object) => object.objectId === artifacts.request.revision.protocolObjectId,
  );
  if (!revisionObject) throw new Error("revision object is missing");
  const revision = parseProtocolObject(revisionObject.bytes);
  const revisionDigest = await sha384(revisionObject.bytes);
  return {
    environmentId: ids.environmentId,
    trustedRevisionId: ids.environmentId,
    trustedRevisionHash: new Uint8Array(48),
    currentHeadId: artifacts.request.revision.id,
    currentHeadHash: revisionDigest,
    projectEpoch: 1n,
    revisions: [
      {
        id: artifacts.request.revision.id,
        digest: revisionDigest,
        parentId: ids.environmentId,
        parentHash: new Uint8Array(48),
        mutation: revision.get(35) as number,
        projectEpoch: BigInt(revision.get(30) as number),
        authoredAtMs: BigInt(revision.get(34) as number),
        rollbackTargetId: null,
        objects: await Promise.all(
          artifacts.stagedObjects.map(async (object) => ({
            objectId: object.objectId,
            canonicalBytes: object.bytes,
            digest: await sha384(object.bytes),
          })),
        ),
      },
    ],
    nextCursor: null,
  };
};

describe("publication artifacts", () => {
  test("creates encrypted definition and value lanes signed by the supplied Device key", async () => {
    const encryption = await generateEncryptionKeyPair();
    const signing = await generateSigningKeyPair();
    const artifacts = await createPublicationArtifacts([variable()], {
      ...ids,
      projectEpoch: 1,
      expectedHeadId: ids.environmentId,
      expectedHeadHash: new Uint8Array(48),
      valueRecipientPublicKey: encryption.publicKey,
      signingPrivateKey: signing.privateKey,
    });

    expect(artifacts.encryptedLaneCount).toBe(2);
    expect(artifacts.servicePlaintextBytes).toBe(0);
    expect(artifacts.request.descriptor.laneCount).toBe(2);
    expect(artifacts.stagedObjects).toHaveLength(4);
    for (const staged of artifacts.stagedObjects) {
      const object = parseProtocolObject(staged.bytes);
      validateProtocolObject(object);
      expect(new TextDecoder().decode(staged.bytes)).not.toContain(
        "postgres://example",
      );
    }
    const definition = artifacts.stagedObjects.find((staged) => {
      const object = parseProtocolObject(staged.bytes);
      return object.get(1) === 13 && object.get(36) === 2;
    });
    if (!definition) throw new Error("definition lane is missing");
    const decoded = JSON.parse(
      new TextDecoder().decode(
        await openLane(definition.bytes, encryption.privateKey),
      ),
    ) as { name: string; description: string };
    expect(decoded).toMatchObject({
      name: "DATABASE_URL",
      description: "Connection string",
    });
  });

  test("keeps a tombstone as a signed encrypted definition lane without sending a value", async () => {
    const encryption = await generateEncryptionKeyPair();
    const signing = await generateSigningKeyPair();
    const artifacts = await createPublicationArtifacts(
      [variable({ tombstone: true, value: null })],
      {
        ...ids,
        projectEpoch: 2,
        expectedHeadId: "88888888-8888-4888-8888-888888888888",
        expectedHeadHash: new Uint8Array(48).fill(9),
        valueRecipientPublicKey: encryption.publicKey,
        signingPrivateKey: signing.privateKey,
      },
    );

    expect(artifacts.encryptedLaneCount).toBe(1);
    expect(artifacts.tombstoneLaneCount).toBe(1);
    expect(artifacts.request.revision.mutation).toBe("MANIFEST_UPDATE");
    validateProtocolObject(parseProtocolObject(artifacts.commandBytes));
  });

  test("accepts a signed lane-scoped Rollback for publication", async () => {
    const encryption = await generateEncryptionKeyPair();
    const signing = await generateSigningKeyPair();
    const artifacts = await createPublicationArtifacts(
      [variable({ value: "previous" })],
      {
        ...ids,
        projectEpoch: 1,
        expectedHeadId: ids.environmentId,
        expectedHeadHash: new Uint8Array(48),
        valueRecipientPublicKey: encryption.publicKey,
        signingPrivateKey: signing.privateKey,
        mutation: "ROLLBACK",
        rollbackTargetId: ids.environmentId,
        rollbackSelectedVariableIds: [variable().id],
      },
    );
    expect(reviewPublication(artifacts.commandBytes).accepted).toBe(true);
    expect(artifacts.request.revision.mutation).toBe("ROLLBACK");
  });

  test("requires a separate recipient key for User-defined Values", async () => {
    const encryption = await generateEncryptionKeyPair();
    const signing = await generateSigningKeyPair();
    await expect(
      createPublicationArtifacts(
        [variable({ ownership: "USER_DEFINED_VALUE" })],
        {
          ...ids,
          projectEpoch: 1,
          expectedHeadId: null,
          expectedHeadHash: null,
          valueRecipientPublicKey: encryption.publicKey,
          signingPrivateKey: signing.privateKey,
        },
      ),
    ).rejects.toThrow("User-defined Value recipient key is required");
  });

  test("preserves an optional absent Value by omitting its value lane", async () => {
    const encryption = await generateEncryptionKeyPair();
    const signing = await generateSigningKeyPair();
    const artifacts = await createPublicationArtifacts(
      [variable({ value: null, required: false })],
      {
        ...ids,
        projectEpoch: 1,
        expectedHeadId: null,
        expectedHeadHash: null,
        valueRecipientPublicKey: encryption.publicKey,
        signingPrivateKey: signing.privateKey,
      },
    );
    expect(artifacts.request.descriptor.laneCount).toBe(1);
    expect(artifacts.encryptedLaneCount).toBe(1);
  });

  test("uses the stable Environment genesis parent and consistent authored time", async () => {
    const encryption = await generateEncryptionKeyPair();
    const signing = await generateSigningKeyPair();
    const artifacts = await createPublicationArtifacts([variable()], {
      ...ids,
      projectEpoch: 1,
      expectedHeadId: null,
      expectedHeadHash: null,
      valueRecipientPublicKey: encryption.publicKey,
      signingPrivateKey: signing.privateKey,
      mutation: "GENESIS",
    });
    const revisionObject = artifacts.stagedObjects.find(
      (object) =>
        object.objectId === artifacts.request.revision.protocolObjectId,
    );
    if (!revisionObject) throw new Error("revision object is missing");
    const revision = parseProtocolObject(revisionObject.bytes);
    expect(revision.get(19)).toEqual(uuidToBytes(ids.environmentId));
    expect(revision.get(34)).toBe(artifacts.request.revision.authoredAtMs);
    await verifySyncPage(
      await syncPageFor(artifacts),
      await exportSigningPublicKey(signing.publicKey),
    );
  });

  test("rejects a stale GENESIS once a verified head exists", async () => {
    const encryption = await generateEncryptionKeyPair();
    const signing = await generateSigningKeyPair();
    await expect(
      createPublicationArtifacts([variable()], {
        ...ids,
        projectEpoch: 1,
        expectedHeadId: "88888888-8888-4888-8888-888888888888",
        expectedHeadHash: new Uint8Array(48).fill(9),
        valueRecipientPublicKey: encryption.publicKey,
        signingPrivateKey: signing.privateKey,
        mutation: "GENESIS",
      }),
    ).rejects.toThrow("GENESIS requires an empty Environment head");
  });

  test("rejects a MANIFEST_UPDATE into an empty Environment", async () => {
    const encryption = await generateEncryptionKeyPair();
    const signing = await generateSigningKeyPair();
    await expect(
      createPublicationArtifacts([variable()], {
        ...ids,
        projectEpoch: 1,
        expectedHeadId: null,
        expectedHeadHash: null,
        valueRecipientPublicKey: encryption.publicKey,
        signingPrivateKey: signing.privateKey,
        mutation: "MANIFEST_UPDATE",
      }),
    ).rejects.toThrow("MANIFEST_UPDATE requires a non-empty Environment head");
  });

  test("accepts a peer Device signature when that Device is in the trust set", async () => {
    const encryption = await generateEncryptionKeyPair();
    const author = await generateSigningKeyPair();
    const other = await generateSigningKeyPair();
    const artifacts = await createPublicationArtifacts([variable()], {
      ...ids,
      projectEpoch: 1,
      expectedHeadId: null,
      expectedHeadHash: null,
      valueRecipientPublicKey: encryption.publicKey,
      signingPrivateKey: author.privateKey,
      mutation: "GENESIS",
    });
    const page = await syncPageFor(artifacts);
    const otherKey = await exportSigningPublicKey(other.publicKey);
    const authorKey = await exportSigningPublicKey(author.publicKey);
    await expect(verifySyncPage(page, otherKey)).rejects.toThrow(
      "signature verification failed",
    );
    await verifySyncPage(page, [otherKey, authorKey]);
  });

  test("rolls back only the selected Value lane without rewriting its definition", async () => {
    const encryption = await generateEncryptionKeyPair();
    const signing = await generateSigningKeyPair();
    const artifacts = await createPublicationArtifacts([variable()], {
      ...ids,
      projectEpoch: 1,
      expectedHeadId: ids.environmentId,
      expectedHeadHash: new Uint8Array(48),
      valueRecipientPublicKey: encryption.publicKey,
      signingPrivateKey: signing.privateKey,
      mutation: "ROLLBACK",
      rollbackTargetId: "88888888-8888-4888-8888-888888888888",
      rollbackSelectedVariableIds: [variable().id],
    });

    expect(artifacts.request.revision.mutation).toBe("ROLLBACK");
    expect(artifacts.request.descriptor.laneCount).toBe(1);
    expect(artifacts.stagedObjects).toHaveLength(3);
    expect(
      artifacts.stagedObjects.some(
        (staged) =>
          parseProtocolObject(staged.bytes).get(1) === 13 &&
          parseProtocolObject(staged.bytes).get(36) === 2,
      ),
    ).toBe(false);
  });

  test("rejects a sync page when an object digest is tampered", async () => {
    const encryption = await generateEncryptionKeyPair();
    const signing = await generateSigningKeyPair();
    const artifacts = await createPublicationArtifacts([variable()], {
      ...ids,
      projectEpoch: 1,
      expectedHeadId: ids.environmentId,
      expectedHeadHash: new Uint8Array(48),
      valueRecipientPublicKey: encryption.publicKey,
      signingPrivateKey: signing.privateKey,
    });
    const revisionObject = artifacts.stagedObjects.find(
      (object) =>
        object.objectId === artifacts.request.revision.protocolObjectId,
    );
    if (!revisionObject) throw new Error("revision object is missing");
    const revision = parseProtocolObject(revisionObject.bytes);
    await expect(
      verifySyncPage(
        {
          environmentId: ids.environmentId,
          trustedRevisionId: ids.environmentId,
          trustedRevisionHash: new Uint8Array(48),
          currentHeadId: artifacts.request.revision.id,
          currentHeadHash: new Uint8Array(48),
          projectEpoch: 1n,
          revisions: [
            {
              id: artifacts.request.revision.id,
              digest: new Uint8Array(48),
              parentId: ids.environmentId,
              parentHash: new Uint8Array(48),
              mutation: revision.get(35) as number,
              projectEpoch: BigInt(revision.get(30) as number),
              authoredAtMs: BigInt(revision.get(34) as number),
              rollbackTargetId: null,
              objects: [
                {
                  objectId: revisionObject.objectId,
                  canonicalBytes: revisionObject.bytes,
                  digest: new Uint8Array(48),
                },
              ],
            },
          ],
          nextCursor: null,
        },
        await exportSigningPublicKey(signing.publicKey),
      ),
    ).rejects.toThrow("revision digest mismatch");
  });

  test("verifies every object digest and the revision manifest hash", async () => {
    const encryption = await generateEncryptionKeyPair();
    const signing = await generateSigningKeyPair();
    const artifacts = await createPublicationArtifacts([variable()], {
      ...ids,
      projectEpoch: 1,
      expectedHeadId: ids.environmentId,
      expectedHeadHash: new Uint8Array(48),
      valueRecipientPublicKey: encryption.publicKey,
      signingPrivateKey: signing.privateKey,
    });
    const revisionObject = artifacts.stagedObjects.find(
      (object) =>
        object.objectId === artifacts.request.revision.protocolObjectId,
    );
    if (!revisionObject) throw new Error("revision object is missing");
    const revision = parseProtocolObject(revisionObject.bytes);
    const revisionDigest = await sha384(revisionObject.bytes);
    const objectDigests = new Map(
      await Promise.all(
        artifacts.stagedObjects.map(
          async (object) =>
            [object.objectId, await sha384(object.bytes)] as const,
        ),
      ),
    );
    await verifySyncPage(
      {
        environmentId: ids.environmentId,
        trustedRevisionId: ids.environmentId,
        trustedRevisionHash: new Uint8Array(48),
        currentHeadId: artifacts.request.revision.id,
        currentHeadHash: revisionDigest,
        projectEpoch: 1n,
        revisions: [
          {
            id: artifacts.request.revision.id,
            digest: revisionDigest,
            parentId: ids.environmentId,
            parentHash: new Uint8Array(48),
            mutation: revision.get(35) as number,
            projectEpoch: BigInt(revision.get(30) as number),
            authoredAtMs: BigInt(revision.get(34) as number),
            rollbackTargetId: null,
            objects: artifacts.stagedObjects.map((object) => ({
              objectId: object.objectId,
              canonicalBytes: object.bytes,
              digest: objectDigests.get(object.objectId) ?? new Uint8Array(48),
            })),
          },
        ],
        nextCursor: null,
      },
      await exportSigningPublicKey(signing.publicKey),
    );
  });

  test("a second Device reads Shared Values sealed with the Project epoch key", async () => {
    const first = await generateEncryptionKeyPair();
    const second = await generateEncryptionKeyPair();
    const signing = await generateSigningKeyPair();
    const epochKey = crypto.getRandomValues(new Uint8Array(32));
    const artifacts = await createPublicationArtifacts([variable()], {
      ...ids,
      projectEpoch: 1,
      expectedHeadId: ids.environmentId,
      expectedHeadHash: new Uint8Array(48),
      valueRecipientPublicKey: first.publicKey,
      signingPrivateKey: signing.privateKey,
      sharedValueSecret: epochKey,
    });
    const definition = artifacts.stagedObjects.find((staged) => {
      const object = parseProtocolObject(staged.bytes);
      return object.get(1) === 13 && object.get(36) === 2;
    });
    if (!definition) throw new Error("definition lane is missing");
    await expect(
      openLane(definition.bytes, second.privateKey),
    ).rejects.toBeInstanceOf(Error);
    const decoded = JSON.parse(
      new TextDecoder().decode(
        await openLane(definition.bytes, second.privateKey, epochKey),
      ),
    ) as { name: string };
    expect(decoded.name).toBe("DATABASE_URL");
  });

  test("a second Device skips Device-sealed genesis and reads the epoch-sealed head", async () => {
    const first = await generateEncryptionKeyPair();
    const second = await generateEncryptionKeyPair();
    const signing = await generateSigningKeyPair();
    const epochKey = crypto.getRandomValues(new Uint8Array(32));
    const genesis = await createPublicationArtifacts([variable()], {
      ...ids,
      projectEpoch: 1,
      expectedHeadId: ids.environmentId,
      expectedHeadHash: new Uint8Array(48),
      valueRecipientPublicKey: first.publicKey,
      signingPrivateKey: signing.privateKey,
    });
    const live = await createPublicationArtifacts(
      [variable({ hasDraftChange: true })],
      {
        ...ids,
        projectEpoch: 1,
        expectedHeadId: genesis.request.revision.id,
        expectedHeadHash: await sha384(
          genesis.stagedObjects.find(
            (object) =>
              object.objectId === genesis.request.revision.protocolObjectId,
          )?.bytes ?? new Uint8Array(),
        ),
        valueRecipientPublicKey: first.publicKey,
        signingPrivateKey: signing.privateKey,
        sharedValueSecret: epochKey,
        mutation: "MANIFEST_UPDATE",
      },
    );
    const pageObjects = async (
      artifacts: Awaited<ReturnType<typeof createPublicationArtifacts>>,
    ) =>
      Promise.all(
        artifacts.stagedObjects.map(async (object) => ({
          objectId: object.objectId,
          canonicalBytes: object.bytes,
          digest: await sha384(object.bytes),
        })),
      );
    const genesisDigest = await sha384(
      genesis.stagedObjects.find(
        (object) =>
          object.objectId === genesis.request.revision.protocolObjectId,
      )?.bytes ?? new Uint8Array(),
    );
    const decoded = await decodeSyncVariables(
      {
        environmentId: ids.environmentId,
        trustedRevisionId: ids.environmentId,
        trustedRevisionHash: new Uint8Array(48),
        currentHeadId: live.request.revision.id,
        currentHeadHash: new Uint8Array(48),
        projectEpoch: 1n,
        revisions: [
          {
            id: genesis.request.revision.id,
            digest: genesisDigest,
            parentId: ids.environmentId,
            parentHash: new Uint8Array(48),
            mutation: 1,
            projectEpoch: 1n,
            authoredAtMs: BigInt(genesis.request.revision.authoredAtMs),
            rollbackTargetId: null,
            objects: await pageObjects(genesis),
          },
          {
            id: live.request.revision.id,
            digest: new Uint8Array(48),
            parentId: genesis.request.revision.id,
            parentHash: genesisDigest,
            mutation: 2,
            projectEpoch: 1n,
            authoredAtMs: BigInt(live.request.revision.authoredAtMs),
            rollbackTargetId: null,
            objects: await pageObjects(live),
          },
        ],
        nextCursor: null,
      },
      () => second.privateKey,
      [],
      epochKey,
    );
    expect(decoded).toEqual([
      expect.objectContaining({
        name: "DATABASE_URL",
        value: "postgres://example",
      }),
    ]);
  });
});
