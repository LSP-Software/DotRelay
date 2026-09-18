import { describe, expect, test } from "bun:test";
import {
  exportSigningPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  parseProtocolObject,
  sha384,
} from "@dotrelay/contracts";
import {
  createPublicationArtifacts,
  type PublicationVariable,
  type RevisionSigningTrustEntry,
  UnreadableLaneError,
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

const variable = (): PublicationVariable => ({
  id: "77777777-7777-4777-8777-777777777777",
  name: "DATABASE_URL",
  description: "Connection string",
  ownership: "SHARED_VALUE",
  value: "postgres://example",
  required: true,
  hasDraftChange: true,
});

const unused = async (): Promise<never> => {
  throw new Error("unused transport method");
};

const transportFor = (page: Awaited<ReturnType<typeof syncPageFor>>) =>
  Object.freeze({
    begin: unused,
    stage: unused,
    finalize: unused,
    cancel: unused,
    sync: unused,
    syncAll: async () => page,
  }) as unknown as ProtocolTransport;

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

const ABSENT_VARIABLE_ID = "88888888-8888-4888-8888-888888888888";

// A session that has verified and decoded one Genesis Revision holding a
// single Variable, so resolveRollbackValues has a snapshot to read.
const syncedGenesisSession = async (): Promise<{
  readonly session: ReturnType<typeof createVerifiedEnvironmentSession>;
  readonly revisionId: string;
}> => {
  const encryption = await generateEncryptionKeyPair();
  const local = await generateSigningKeyPair();
  const author = await generateSigningKeyPair();
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
  const localKey = await exportSigningPublicKey(local.publicKey);
  const authorKey = await exportSigningPublicKey(author.publicKey);
  const context = {
    ...ids,
    projectEpoch: 1,
    expectedHeadId: page.currentHeadId,
    expectedHeadHash: page.currentHeadHash,
    valueRecipientPublicKey: encryption.publicKey,
    signingPrivateKey: local.privateKey,
    revisionSigningPublicKey: localKey,
  };
  const request = {
    environmentId: ids.environmentId,
    deviceId: ids.actorDeviceId,
    request: {
      trustedRevisionId: ids.environmentId,
      trustedRevisionHash: new Uint8Array(48),
    },
  };
  const session = createVerifiedEnvironmentSession({
    context,
    transport: transportFor(page),
    sharedValuePrivateKey: encryption.privateKey,
    signingTrustKeys: [localKey, authorKey],
  });
  await session.syncAndDecode(request);
  return { session, revisionId: page.currentHeadId };
};

describe("verified Environment session", () => {
  test("verifies peer-signed Revisions with the workspace signing trust set", async () => {
    const encryption = await generateEncryptionKeyPair();
    const local = await generateSigningKeyPair();
    const author = await generateSigningKeyPair();
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
    const localKey = await exportSigningPublicKey(local.publicKey);
    const authorKey = await exportSigningPublicKey(author.publicKey);
    const context = {
      ...ids,
      projectEpoch: 1,
      expectedHeadId: page.currentHeadId,
      expectedHeadHash: page.currentHeadHash,
      valueRecipientPublicKey: encryption.publicKey,
      signingPrivateKey: local.privateKey,
      revisionSigningPublicKey: localKey,
    };
    const request = {
      environmentId: ids.environmentId,
      deviceId: ids.actorDeviceId,
      request: {
        trustedRevisionId: ids.environmentId,
        trustedRevisionHash: new Uint8Array(48),
      },
    };
    await expect(
      createVerifiedEnvironmentSession({
        context,
        transport: transportFor(page),
        sharedValuePrivateKey: encryption.privateKey,
      }).syncAndDecode(request),
    ).rejects.toThrow("signature verification failed");
    const synced = await createVerifiedEnvironmentSession({
      context,
      transport: transportFor(page),
      sharedValuePrivateKey: encryption.privateKey,
      signingTrustKeys: [localKey, authorKey],
    }).syncAndDecode(request);
    expect(synced.variables).toEqual([
      expect.objectContaining({
        name: "DATABASE_URL",
        value: "postgres://example",
      }),
    ]);
  });

  // Builds a Genesis page signed by `author` and returns a session that
  // trusts `entries`, so a test can assert how the scoped trust set admits or
  // rejects that page.
  const scopedSession = async (
    author: Awaited<ReturnType<typeof generateSigningKeyPair>>,
    entries: readonly RevisionSigningTrustEntry[],
  ) => {
    const encryption = await generateEncryptionKeyPair();
    const local = await generateSigningKeyPair();
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
    const localKey = await exportSigningPublicKey(local.publicKey);
    const context = {
      ...ids,
      projectEpoch: 1,
      expectedHeadId: page.currentHeadId,
      expectedHeadHash: page.currentHeadHash,
      valueRecipientPublicKey: encryption.publicKey,
      signingPrivateKey: local.privateKey,
      revisionSigningPublicKey: localKey,
    };
    return createVerifiedEnvironmentSession({
      context,
      transport: transportFor(page),
      sharedValuePrivateKey: encryption.privateKey,
      signingTrustKeys: entries,
    });
  };

  const syncRequest = {
    environmentId: ids.environmentId,
    deviceId: ids.deviceId,
    request: {
      trustedRevisionId: ids.environmentId,
      trustedRevisionHash: new Uint8Array(48),
    },
  };

  test("verifies a peer-signed Revision through its authorized Device and Membership windows", async () => {
    const author = await generateSigningKeyPair();
    const authorKey = await exportSigningPublicKey(author.publicKey);
    const session = await scopedSession(author, [
      {
        publicKey: authorKey,
        deviceId: ids.device,
        userId: ids.user,
        deviceActiveFromMs: 0,
        deviceActiveUntilMs: null,
        memberSinceMs: 0,
        memberUntilMs: null,
      },
    ]);
    const synced = await session.syncAndDecode(syncRequest);
    expect(synced.variables).toEqual([
      expect.objectContaining({
        name: "DATABASE_URL",
        value: "postgres://example",
      }),
    ]);
  });

  test("rejects a Revision authored after its signing Device was revoked", async () => {
    const author = await generateSigningKeyPair();
    const authorKey = await exportSigningPublicKey(author.publicKey);
    const revokedAtMs = Date.now() - 60_000;
    const session = await scopedSession(author, [
      {
        publicKey: authorKey,
        deviceId: ids.device,
        userId: ids.user,
        deviceActiveFromMs: 0,
        deviceActiveUntilMs: revokedAtMs,
        memberSinceMs: 0,
        memberUntilMs: null,
      },
    ]);
    await expect(session.syncAndDecode(syncRequest)).rejects.toThrow(
      "sync revision signature is not authorized",
    );
  });

  test("rejects a Revision whose recorded signing Device is not the trusted Device", async () => {
    const author = await generateSigningKeyPair();
    const authorKey = await exportSigningPublicKey(author.publicKey);
    const session = await scopedSession(author, [
      {
        publicKey: authorKey,
        deviceId: "99999999-9999-4999-8999-999999999999",
        userId: ids.user,
        deviceActiveFromMs: 0,
        deviceActiveUntilMs: null,
        memberSinceMs: 0,
        memberUntilMs: null,
      },
    ]);
    await expect(session.syncAndDecode(syncRequest)).rejects.toThrow(
      "sync revision signature is not authorized",
    );
  });

  test("rejects a Revision authored after the author's Membership ended", async () => {
    const author = await generateSigningKeyPair();
    const authorKey = await exportSigningPublicKey(author.publicKey);
    const removedAtMs = Date.now() - 60_000;
    const session = await scopedSession(author, [
      {
        publicKey: authorKey,
        deviceId: ids.device,
        userId: ids.user,
        deviceActiveFromMs: 0,
        deviceActiveUntilMs: null,
        memberSinceMs: 0,
        memberUntilMs: removedAtMs,
      },
    ]);
    await expect(session.syncAndDecode(syncRequest)).rejects.toThrow(
      "sync revision signature is not authorized",
    );
  });

  test("syncAndDecode rejects a Manifest this Device cannot decrypt", async () => {
    const encryption = await generateEncryptionKeyPair();
    const local = await generateSigningKeyPair();
    const author = await generateSigningKeyPair();
    const epochKey = crypto.getRandomValues(new Uint8Array(32));
    const artifacts = await createPublicationArtifacts([variable()], {
      ...ids,
      projectEpoch: 1,
      expectedHeadId: null,
      expectedHeadHash: null,
      valueRecipientPublicKey: encryption.publicKey,
      signingPrivateKey: author.privateKey,
      sharedValueSecret: epochKey,
      mutation: "GENESIS",
    });
    const page = await syncPageFor(artifacts);
    const localKey = await exportSigningPublicKey(local.publicKey);
    const authorKey = await exportSigningPublicKey(author.publicKey);
    const context = {
      ...ids,
      projectEpoch: 1,
      expectedHeadId: page.currentHeadId,
      expectedHeadHash: page.currentHeadHash,
      valueRecipientPublicKey: encryption.publicKey,
      signingPrivateKey: local.privateKey,
      revisionSigningPublicKey: localKey,
    };
    // The Device's Project key grant is missing or stale: it holds no key
    // that opens the page's lanes.
    const session = createVerifiedEnvironmentSession({
      context,
      transport: transportFor(page),
      sharedValuePrivateKey: encryption.privateKey,
      signingTrustKeys: [localKey, authorKey],
    });
    await expect(
      session.syncAndDecode({
        environmentId: ids.environmentId,
        deviceId: ids.actorDeviceId,
        request: {
          trustedRevisionId: ids.environmentId,
          trustedRevisionHash: new Uint8Array(48),
        },
      }),
    ).rejects.toBeInstanceOf(UnreadableLaneError);
  });

  test("resolveRollbackValues omits a Variable verified absent from the target Revision", async () => {
    const { session, revisionId } = await syncedGenesisSession();
    const values = await session.resolveRollbackValues({
      targetRevision: revisionId,
      selectedVariableIds: [variable().id, ABSENT_VARIABLE_ID],
    });
    expect(values.get(variable().id)).toBe("postgres://example");
    // The Genesis snapshot verified this Variable was never part of the
    // Revision, so the answer is absence in the result, not a failure.
    expect(values.has(ABSENT_VARIABLE_ID)).toBe(false);
  });

  test("resolveRollbackValues rejects a target Revision missing from verified history", async () => {
    const { session } = await syncedGenesisSession();
    await expect(
      session.resolveRollbackValues({
        targetRevision: "99999999-9999-4999-8999-999999999999",
        selectedVariableIds: [variable().id],
      }),
    ).rejects.toThrow("not present in the local sync cache");
  });
});
