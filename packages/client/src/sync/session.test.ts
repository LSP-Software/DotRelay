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
});
