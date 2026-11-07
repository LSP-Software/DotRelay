import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  createEpochRotationArtifacts,
  createProjectEpochKeyLink,
  createProtocolTransport,
  createPublicationArtifacts,
  createVerifiedEnvironmentSession,
  openProjectEpochKeyChain,
  type ProtocolTransport,
  type PublicationContext,
} from "@dotrelay/client";
import {
  exportSigningPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  parseProtocolObject,
  sha384,
} from "@dotrelay/contracts";
import {
  AdministrationRepository,
  createDatabaseClient,
  type DatabaseClient,
  ensureServerProfile,
  ProjectRepository,
  sha384Digest,
} from "@dotrelay/database";
import type { DotRelayAuth } from "./auth";
import { createApi } from "./index";
import { loadServerProfileConfig } from "./profile";

// Real-Postgres, real-route coverage for ADR 0014: a Project rotated twice
// through the API carries a contiguous key chain, and a Member who holds only
// the current epoch key rebuilds every earlier key and reads every Value.
const integrationDescribe = process.env.DATABASE_URL ? describe : describe.skip;
const HOOK_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 30_000;
const sourceDatabaseUrl = process.env.DATABASE_URL;
const testDatabaseName = `dotrelay_chain_${crypto
  .randomUUID()
  .replaceAll("-", "")}`;
const testDatabaseUrl = sourceDatabaseUrl
  ? new URL(sourceDatabaseUrl)
  : undefined;
if (testDatabaseUrl) testDatabaseUrl.pathname = `/${testDatabaseName}`;
const adminDatabaseUrl = sourceDatabaseUrl
  ? new URL(sourceDatabaseUrl)
  : undefined;
if (adminDatabaseUrl) adminDatabaseUrl.pathname = "/postgres";
const databasePackage = fileURLToPath(
  new URL("../../../packages/database", import.meta.url),
);
const quoteIdentifier = (value: string): string =>
  `"${value.replaceAll('"', '""')}"`;

const profile = loadServerProfileConfig(process.env);
const TOKEN = "chain-owner-token";
const authSubject = `auth-chain-${crypto.randomUUID()}`;

const authStub = (): DotRelayAuth =>
  ({
    api: {
      getSession: async ({ headers }: { headers: Headers }) =>
        headers.get("Authorization") === `Bearer ${TOKEN}`
          ? { user: { id: authSubject, name: "Chain Owner" } }
          : null,
    },
    $context: Promise.resolve({
      options: {},
      secretConfig: { secret: "test-secret" },
    }),
  }) as unknown as DotRelayAuth;

const runMigrations = async () => {
  if (!testDatabaseUrl) throw new Error("DATABASE_URL is required");
  const subprocess = Bun.spawn(
    [
      process.execPath,
      "x",
      "prisma",
      "migrate",
      "deploy",
      "--config",
      "prisma.config.ts",
    ],
    {
      cwd: databasePackage,
      env: { ...process.env, DATABASE_URL: testDatabaseUrl.toString() },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`migration failed: ${stdout}\n${stderr}`);
};

let database: DatabaseClient;
let app: ReturnType<typeof createApi>;
let transport: ProtocolTransport;
let userId = "";
let deviceId = "";
let teamId = "";
let projectId = "";
let environmentId = "";
let signing: CryptoKeyPair;

const boundary = async (): Promise<Record<string, unknown>> => {
  const response = await app.request(
    `${profile.origin}/api/v1/workspace/boundary?environment=${environmentId}`,
    {
      headers: {
        Origin: profile.origin,
        Authorization: `Bearer ${TOKEN}`,
        "X-DotRelay-Device-Id": deviceId,
      },
    },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
};

const postLink = (operationId: string, objectId: string, bytes: Uint8Array) =>
  app.request(
    `${profile.origin}/api/v1/projects/${projectId}/epoch-key-links`,
    {
      method: "POST",
      headers: {
        Origin: profile.origin,
        Authorization: `Bearer ${TOKEN}`,
        "X-DotRelay-Device-Id": deviceId,
        "Idempotency-Key": operationId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        operationId,
        objectId,
        object: Buffer.from(bytes).toString("base64"),
      }),
    },
  );

integrationDescribe(
  "Project epoch key chain through the API (PostgreSQL)",
  () => {
    beforeAll(async () => {
      if (!adminDatabaseUrl || !testDatabaseUrl)
        throw new Error("DATABASE_URL is required");
      const admin = new Client({
        connectionString: adminDatabaseUrl.toString(),
      });
      await admin.connect();
      try {
        await admin.query(
          `CREATE DATABASE ${quoteIdentifier(testDatabaseName)}`,
        );
      } finally {
        await admin.end();
      }
      await runMigrations();
      database = createDatabaseClient(testDatabaseUrl.toString());
      await ensureServerProfile(database, {
        id: profile.id,
        origin: profile.origin,
        allowRebind: profile.allowRebind,
      });
      userId = (
        await database.user.create({
          data: {
            serverProfileId: profile.id,
            authSubject,
            githubSubject: "2002",
          },
        })
      ).id;
      await database.authUser.create({
        data: {
          id: authSubject,
          name: "Chain Owner",
          email: `chain-${crypto.randomUUID()}@example.test`,
        },
      });
      await database.authAccount.create({
        data: {
          id: crypto.randomUUID(),
          accountId: "2002",
          providerId: "github",
          userId: authSubject,
        },
      });
      signing = await generateSigningKeyPair();
      const x25519PublicKey = crypto.getRandomValues(new Uint8Array(32));
      deviceId = (
        await database.device.create({
          data: {
            id: crypto.randomUUID(),
            userId,
            lifecycle: "ACTIVE",
            identityGeneration: 1n,
            keyId: new Uint8Array(await sha384Digest(x25519PublicKey)),
            x25519PublicKey,
            ed25519PublicKey: new Uint8Array(
              await crypto.subtle.exportKey("raw", signing.publicKey),
            ),
            activatedAt: new Date(),
          },
        })
      ).id;
      const operation = async (label: string) => {
        const commandBytes = new TextEncoder().encode(label);
        return {
          id: crypto.randomUUID(),
          actorUserId: userId,
          actorDeviceId: deviceId,
          kind: "ADMINISTRATION" as const,
          commandBytes,
          commandDigest: await sha384Digest(commandBytes),
        };
      };
      teamId = crypto.randomUUID();
      await new AdministrationRepository().createTeamWithOwner(database, {
        teamId,
        serverProfileId: profile.id,
        ownerUserId: userId,
        name: "chain-team",
        operation: await operation("chain-team"),
      });
      projectId = crypto.randomUUID();
      const created = await new ProjectRepository().create(database, {
        teamId,
        projectId,
        githubRepositoryId: BigInt(Date.now()),
        operation: await operation("chain-project"),
      });
      if (!("environment" in created))
        throw new Error("project creation did not provision an environment");
      environmentId = created.environment.id;
      app = createApi({ database, profile, auth: authStub() });
      transport = createProtocolTransport({
        origin: profile.origin,
        authorization: `Bearer ${TOKEN}`,
        fetch: (url, init) =>
          Promise.resolve(app.fetch(new Request(url, init as RequestInit))),
      });
    }, HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await database?.$disconnect();
      if (!adminDatabaseUrl) return;
      const admin = new Client({
        connectionString: adminDatabaseUrl.toString(),
      });
      await admin.connect();
      try {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [testDatabaseName],
        );
        await admin.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(testDatabaseName)}`,
        );
      } finally {
        await admin.end();
      }
    }, HOOK_TIMEOUT_MS);

    test(
      "two rotations publish a chain a late joiner walks to read every Value",
      async () => {
        const elsewhere = await generateEncryptionKeyPair();
        const epochKeys = new Map<number, Uint8Array>([
          [1, crypto.getRandomValues(new Uint8Array(32))],
        ]);
        let head: { id: string; hash: Uint8Array } | null = null;
        const context = (projectEpoch: number): PublicationContext => ({
          serverProfileId: profile.id,
          teamId,
          projectId,
          environmentId,
          actorUserId: userId,
          actorDeviceId: deviceId,
          projectEpoch,
          expectedHeadId: head?.id ?? null,
          expectedHeadHash: head?.hash ?? null,
          valueRecipientPublicKey: elsewhere.publicKey,
          sharedValueSecret: epochKeys.get(projectEpoch)!,
          signingPrivateKey: signing.privateKey,
          mutation: head ? "MANIFEST_UPDATE" : "GENESIS",
        });
        const publish = async (
          projectEpoch: number,
          name: string,
          value: string,
        ) => {
          const artifacts = await createPublicationArtifacts(
            [
              {
                id: crypto.randomUUID(),
                name,
                description: "",
                ownership: "SHARED_VALUE",
                value,
                required: true,
                hasDraftChange: true,
              },
            ],
            context(projectEpoch),
          );
          const operationId = crypto.randomUUID();
          await transport.begin({
            operationId,
            deviceId,
            kind: "REVISION_PUBLICATION",
            commandBytes: artifacts.commandBytes,
            commandDigest: await sha384(artifacts.commandBytes),
          });
          for (const staged of artifacts.stagedObjects)
            await transport.stage({
              operationId,
              deviceId,
              objectId: staged.objectId,
              bytes: staged.bytes,
            });
          await transport.finalize({
            operationId,
            deviceId,
            request: artifacts.request,
          });
          const revision = artifacts.stagedObjects.find(
            (staged) =>
              staged.objectId === artifacts.request.revision.protocolObjectId,
          )!;
          head = {
            id: artifacts.request.revision.id,
            hash: await sha384(revision.bytes),
          };
        };
        const rotate = async (expectedEpoch: number) => {
          const artifacts = await createEpochRotationArtifacts({
            serverProfileId: profile.id,
            teamId,
            projectId,
            actorUserId: userId,
            actorDeviceId: deviceId,
            expectedEpoch,
            environments: [
              {
                environmentId,
                expectedHeadId: head!.id,
                expectedHeadHash: head!.hash,
              },
            ],
            signingPrivateKey: signing.privateKey,
            previousEpochKey: epochKeys.get(expectedEpoch)!,
          });
          const operationId = crypto.randomUUID();
          await transport.begin({
            operationId,
            deviceId,
            kind: "EPOCH_ROTATION",
            commandBytes: artifacts.commandBytes,
            commandDigest: await sha384(artifacts.commandBytes),
          });
          for (const staged of artifacts.stagedObjects)
            await transport.stage({
              operationId,
              deviceId,
              objectId: staged.objectId,
              bytes: staged.bytes,
            });
          const rotated = await transport.epochRotate({
            operationId,
            deviceId,
            request: artifacts.request,
          });
          expect(rotated.idempotent).toBe(false);
          // A byte-identical retry is idempotent.
          expect(
            (
              await transport.epochRotate({
                operationId,
                deviceId,
                request: artifacts.request,
              })
            ).idempotent,
          ).toBe(true);
          epochKeys.set(expectedEpoch + 1, artifacts.newEpochKey);
          const transition = artifacts.request.transitions[0]!;
          const revision = artifacts.stagedObjects.find(
            (staged) =>
              staged.objectId ===
              transition.publication.revision.protocolObjectId,
          )!;
          head = {
            id: transition.newHeadId,
            hash: await sha384(revision.bytes),
          };
        };

        await publish(1, "DATABASE_URL", "postgres://epoch-one");
        await rotate(1);
        await publish(2, "API_KEY", "epoch-two-value");
        await rotate(2);
        await publish(3, "LOG_LEVEL", "epoch-three");

        const served = await boundary();
        expect(served.projectEpoch).toBe("3");
        const links = (served.epochKeyLinks as string[]).map((link) =>
          Buffer.from(link, "base64"),
        );
        expect(
          links.map((link) => {
            const object = parseProtocolObject(new Uint8Array(link));
            return [object.get(62), object.get(63)];
          }),
        ).toEqual([
          [1, 2],
          [2, 3],
        ]);

        // A Member who joined now holds only the epoch-3 key.
        const chain = await openProjectEpochKeyChain({
          serverProfileId: profile.id,
          teamId,
          projectId,
          links: links.map((link) => new Uint8Array(link)),
          currentEpoch: 3,
          currentKey: epochKeys.get(3)!,
          trustedSigningKeys: [await exportSigningPublicKey(signing.publicKey)],
        });
        expect(chain.break).toBeNull();
        expect(chain.ring.get(1)).toEqual(epochKeys.get(1)!);
        expect(chain.ring.get(2)).toEqual(epochKeys.get(2)!);

        const session = createVerifiedEnvironmentSession({
          context: { ...context(3), sharedValueSecret: epochKeys.get(3)! },
          transport,
          sharedValuePrivateKey: elsewhere.privateKey,
          signingTrustKeys: [await exportSigningPublicKey(signing.publicKey)],
          sharedValueSecret: epochKeys.get(3)!,
          sharedValueKeyRing: chain.ring,
        });
        const { variables } = await session.syncAndDecode({
          environmentId,
          deviceId,
          request: {
            trustedRevisionId: environmentId,
            trustedRevisionHash: new Uint8Array(48),
            pagination: {},
          },
        });
        expect(
          Object.fromEntries(
            variables.map((variable) => [variable.name, variable.value]),
          ),
        ).toEqual({
          DATABASE_URL: "postgres://epoch-one",
          API_KEY: "epoch-two-value",
          LOG_LEVEL: "epoch-three",
        });
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "the backfill route keeps the first link and rejects a rival",
      async () => {
        const rival = await createProjectEpochKeyLink({
          serverProfileId: profile.id,
          teamId,
          projectId,
          fromEpoch: 1,
          fromKey: crypto.getRandomValues(new Uint8Array(32)),
          toKey: crypto.getRandomValues(new Uint8Array(32)),
          signingDeviceId: deviceId,
          signingPrivateKey: signing.privateKey,
        });
        const conflict = await postLink(
          crypto.randomUUID(),
          rival.objectId,
          rival.canonicalBytes,
        );
        expect(conflict.status).toBe(409);
        expect(((await conflict.json()) as { code: string }).code).toBe(
          "state_conflict",
        );

        // The committed link re-posted under a fresh operation is idempotent.
        const served = await boundary();
        const first = Buffer.from(
          (served.epochKeyLinks as string[])[0]!,
          "base64",
        );
        const again = await postLink(
          crypto.randomUUID(),
          crypto.randomUUID(),
          new Uint8Array(first),
        );
        expect(again.status).toBe(201);
        expect(
          ((await again.json()) as { idempotent: boolean }).idempotent,
        ).toBe(true);

        // A link signed by a key other than the actor Device's is refused.
        const stranger = await generateSigningKeyPair();
        const forged = await createProjectEpochKeyLink({
          serverProfileId: profile.id,
          teamId,
          projectId,
          fromEpoch: 2,
          fromKey: crypto.getRandomValues(new Uint8Array(32)),
          toKey: crypto.getRandomValues(new Uint8Array(32)),
          signingDeviceId: deviceId,
          signingPrivateKey: stranger.privateKey,
        });
        const refused = await postLink(
          crypto.randomUUID(),
          forged.objectId,
          forged.canonicalBytes,
        );
        expect(refused.status).toBe(400);
        expect(await database.projectEpochKeyLinkObject.count()).toBe(2);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
