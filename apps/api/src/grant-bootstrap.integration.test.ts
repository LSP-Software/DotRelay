import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { createProjectEpochGrantBootstrap } from "@dotrelay/client";
import {
  generateEncryptionKeyPair,
  generateSigningKeyPair,
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

// Real-Postgres coverage for POST /api/v1/grants/bootstrap: an active Member
// may seal the Project key to their own Devices, never to another User's,
// and a pending or removed Member may not grant at all.
const integrationDescribe = process.env.DATABASE_URL ? describe : describe.skip;
const HOOK_TIMEOUT_MS = 30_000;
const sourceDatabaseUrl = process.env.DATABASE_URL;
const testDatabaseName = `dotrelay_grants_${crypto
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
const tokens = new Map<string, string>();

const authStub = (): DotRelayAuth =>
  ({
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const subject = tokens.get(headers.get("Authorization") ?? "");
        return subject ? { user: { id: subject, name: subject } } : null;
      },
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

type TestDevice = Readonly<{
  id: string;
  signing: CryptoKeyPair;
  encryption: CryptoKeyPair;
  x25519PublicKey: Uint8Array;
}>;

type TestUser = Readonly<{
  id: string;
  authorization: string;
}>;

let database: DatabaseClient;
let app: ReturnType<typeof createApi>;
let teamId = "";
let projectId = "";
let owner: TestUser;
let ownerDevice: TestDevice;
let member: TestUser;
let memberDevice: TestDevice;
let memberLaptop: TestDevice;
let membershipId = "";

const createUser = async (label: string): Promise<TestUser> => {
  const authSubject = `auth-${label}-${crypto.randomUUID()}`;
  const githubSubject = String(Math.floor(Math.random() * 1_000_000_000));
  const authorization = `Bearer ${label}-${crypto.randomUUID()}`;
  tokens.set(authorization, authSubject);
  const user = await database.user.create({
    data: { serverProfileId: profile.id, authSubject, githubSubject },
  });
  await database.authUser.create({
    data: {
      id: authSubject,
      name: label,
      email: `${label}-${crypto.randomUUID()}@example.test`,
    },
  });
  await database.authAccount.create({
    data: {
      id: crypto.randomUUID(),
      accountId: githubSubject,
      providerId: "github",
      userId: authSubject,
    },
  });
  return { id: user.id, authorization };
};

const createDevice = async (userId: string): Promise<TestDevice> => {
  const signing = await generateSigningKeyPair();
  const encryption = await generateEncryptionKeyPair();
  const x25519PublicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", encryption.publicKey),
  );
  const device = await database.device.create({
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
  });
  return { id: device.id, signing, encryption, x25519PublicKey };
};

const postGrant = async (
  actor: TestUser,
  sender: TestDevice,
  recipient: TestDevice,
) => {
  const grant = await createProjectEpochGrantBootstrap({
    serverProfileId: profile.id,
    teamId,
    projectId,
    projectEpoch: 1,
    senderDeviceId: sender.id,
    recipientDeviceId: recipient.id,
    recipientX25519PublicKey: recipient.x25519PublicKey,
    recipientEncryptionPublicKey: recipient.encryption.publicKey,
    signingPrivateKey: sender.signing.privateKey,
  });
  return app.request(`${profile.origin}/api/v1/grants/bootstrap`, {
    method: "POST",
    headers: {
      Origin: profile.origin,
      Authorization: actor.authorization,
      "X-DotRelay-Device-Id": sender.id,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      operationId: crypto.randomUUID(),
      teamId,
      projectId,
      objectId: grant.objectId,
      digest: Buffer.from(grant.digest).toString("base64"),
      grant: Buffer.from(grant.canonicalBytes).toString("base64"),
    }),
  });
};

integrationDescribe("Project grant bootstrap authority (PostgreSQL)", () => {
  beforeAll(async () => {
    if (!adminDatabaseUrl || !testDatabaseUrl)
      throw new Error("DATABASE_URL is required");
    const admin = new Client({ connectionString: adminDatabaseUrl.toString() });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(testDatabaseName)}`);
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
    owner = await createUser("owner");
    ownerDevice = await createDevice(owner.id);
    member = await createUser("member");
    memberDevice = await createDevice(member.id);
    memberLaptop = await createDevice(member.id);
    const operation = async (label: string) => {
      const commandBytes = new TextEncoder().encode(label);
      return {
        id: crypto.randomUUID(),
        actorUserId: owner.id,
        actorDeviceId: ownerDevice.id,
        kind: "ADMINISTRATION" as const,
        commandBytes,
        commandDigest: await sha384Digest(commandBytes),
      };
    };
    teamId = crypto.randomUUID();
    await new AdministrationRepository().createTeamWithOwner(database, {
      teamId,
      serverProfileId: profile.id,
      ownerUserId: owner.id,
      name: "grant-team",
      operation: await operation("grant-team"),
    });
    projectId = crypto.randomUUID();
    await new ProjectRepository().create(database, {
      teamId,
      projectId,
      githubRepositoryId: BigInt(Date.now()),
      operation: await operation("grant-project"),
    });
    membershipId = (
      await database.membership.create({
        data: {
          teamId,
          userId: member.id,
          role: "MEMBER",
          lifecycle: "ACTIVE",
          activatedAt: new Date(),
        },
      })
    ).id;
    app = createApi({ database, profile, auth: authStub() });
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await database?.$disconnect();
    if (!adminDatabaseUrl) return;
    const admin = new Client({ connectionString: adminDatabaseUrl.toString() });
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

  test("an active Member shares the Project key with their own Device", async () => {
    const response = await postGrant(member, memberDevice, memberLaptop);
    expect(response.status).toBe(201);
    expect(
      await database.grantObject.count({
        where: { projectId, recipientDeviceId: memberLaptop.id },
      }),
    ).toBe(1);
  });

  test("refuses a Member's grant to another User's Device", async () => {
    const response = await postGrant(member, memberDevice, ownerDevice);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe(
      "forbidden",
    );
  });

  test("refuses an owner's grant to another User's Device too", async () => {
    const response = await postGrant(owner, ownerDevice, memberLaptop);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe(
      "forbidden",
    );
  });

  test("refuses a pending or removed Member", async () => {
    for (const data of [
      { lifecycle: "PENDING_KEY_GRANT", activatedAt: null, removedAt: null },
      { lifecycle: "REMOVED", removedAt: new Date() },
    ] as const) {
      await database.membership.update({ where: { id: membershipId }, data });
      const response = await postGrant(member, memberDevice, memberLaptop);
      expect(response.status).toBe(403);
      expect(((await response.json()) as { code: string }).code).toBe(
        "forbidden",
      );
    }
  });
});
