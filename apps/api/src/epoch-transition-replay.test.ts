import { expect, test } from "bun:test";
import {
  createEpochRotationArtifacts,
  createProtocolTransport,
} from "@dotrelay/client";
import { COMMAND_STAGE_OBJECT_ID } from "./protocol/constants";
import { createApi } from "./index";
import { loadServerProfileConfig } from "./profile";

const sha384 = async (bytes: Uint8Array) =>
  new Uint8Array(
    await crypto.subtle.digest("SHA-384", bytes as Uint8Array<ArrayBuffer>),
  );

test("a committed epoch rotation replay is idempotent, not a missing-stage 409", async () => {
  const profile = loadServerProfileConfig({});
  const serverProfileId = crypto.randomUUID();
  const teamId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const environmentId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const actorDeviceId = crypto.randomUUID();
  const operationId = crypto.randomUUID();

  const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  const signingPublicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  const expectedHeadId = crypto.randomUUID();

  const artifacts = await createEpochRotationArtifacts({
    serverProfileId,
    teamId,
    projectId,
    actorUserId: userId,
    actorDeviceId,
    expectedEpoch: 1,
    signingPrivateKey: keyPair.privateKey,
    environments: [
      {
        environmentId,
        expectedHeadId,
        expectedHeadHash: crypto.getRandomValues(new Uint8Array(48)),
      },
    ],
  });

  // The rotation already committed: the operation is COMMITTED, its staged
  // objects were promoted (committedAt set), and the project advanced to the
  // new epoch. A replay must resolve that committed staging and return the
  // recorded outcome instead of 409 staged_object_missing.
  const commandDigest = await sha384(artifacts.commandBytes);
  const committedAt = new Date();
  const stagedRows = [
    {
      operationId,
      objectId: COMMAND_STAGE_OBJECT_ID,
      actorDeviceId,
      canonicalBytes: artifacts.commandBytes,
      digest: commandDigest,
      committedAt,
    },
    ...(await Promise.all(
      artifacts.stagedObjects.map(async (staged) => ({
        operationId,
        objectId: staged.objectId,
        actorDeviceId,
        canonicalBytes: staged.bytes,
        digest: await sha384(staged.bytes),
        committedAt,
      })),
    )),
  ];
  const committedOperation = {
    id: operationId,
    actorUserId: userId,
    actorDeviceId,
    kind: "EPOCH_ROTATION",
    commandDigest,
    status: "COMMITTED",
  };

  const database = {
    $executeRaw: async () => 0,
    $transaction: async (
      callback: (transaction: unknown) => Promise<unknown>,
    ) => callback(database),
    authAccount: {
      findFirst: async () => ({ accountId: "github-user" }),
    },
    user: { upsert: async () => ({ id: userId }) },
    device: {
      findFirst: async ({
        where,
      }: {
        where: { id?: string; userId?: string; lifecycle?: string };
      }) =>
        where.id === actorDeviceId &&
        where.userId === userId &&
        (where.lifecycle === undefined || where.lifecycle === "ACTIVE")
          ? { id: actorDeviceId, userId, lifecycle: "ACTIVE" as const }
          : null,
      findUnique: async () => ({
        id: actorDeviceId,
        ed25519PublicKey: signingPublicKey,
      }),
    },
    membership: {
      findFirst: async () => ({
        lifecycle: "ACTIVE" as const,
        role: "OWNER" as const,
      }),
    },
    operation: {
      createMany: async () => ({ count: 1 }),
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === operationId ? committedOperation : null,
    },
    stagedObject: {
      findMany: async ({
        where,
      }: {
        where: {
          operationId: string;
          actorDeviceId: string;
          objectId?: { in: readonly string[] };
          committedAt?: Date | null;
        };
      }) =>
        stagedRows.filter(
          (row) =>
            row.operationId === where.operationId &&
            row.actorDeviceId === where.actorDeviceId &&
            (where.objectId?.in
              ? where.objectId.in.includes(row.objectId)
              : true) &&
            (where.committedAt === undefined
              ? true
              : where.committedAt === row.committedAt),
        ),
    },
    project: {
      findUnique: async () => ({
        id: projectId,
        teamId,
        currentEpoch: 2n,
        lifecycle: "ACTIVE" as const,
      }),
    },
  } as never;

  const app = createApi({
    profile,
    database,
    auth: {
      api: {
        getSession: async () => ({ user: { id: "auth-user" } }),
      },
    } as never,
  });

  // Drive the real client transport so the exact wire serialization (hex hashes,
  // staged object ids) reaches the route; the fetch is routed at the mock app.
  let observedStatus: number | undefined;
  const transport = createProtocolTransport({
    origin: profile.origin,
    authorization: "Bearer current-token",
    fetch: (url, init) =>
      Promise.resolve(app.fetch(new Request(url, init as RequestInit))).then(
        (response) => {
          observedStatus = response.status;
          return response;
        },
      ),
  });

  const result = await transport.epochRotate({
    operationId,
    deviceId: actorDeviceId,
    request: artifacts.request,
  });

  expect(observedStatus).toBe(200);
  expect(result.projectEpoch).toBe("2");
  expect(result.idempotent).toBe(true);
});
