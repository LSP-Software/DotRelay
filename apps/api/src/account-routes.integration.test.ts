import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { accountDeletionCommand } from "@dotrelay/contracts";
import {
  AdministrationRepository,
  createDatabaseClient,
  type DatabaseClient,
  ensureServerProfile,
  ProjectRepository,
  sha384Digest,
} from "@dotrelay/database";
import type { DotRelayAuth } from "./auth";
import { testDeviceProof } from "./device-proof-testing";
import { createApi } from "./index";
import { loadServerProfileConfig } from "./profile";

const integrationDescribe = process.env.DATABASE_URL ? describe : describe.skip;
const INTEGRATION_HOOK_TIMEOUT_MS = 30_000;
const sourceDatabaseUrl = process.env.DATABASE_URL;
const testDatabaseName = `dotrelay_account_${crypto
  .randomUUID()
  .replaceAll("-", "")}`;
const testDatabaseUrl = sourceDatabaseUrl
  ? new URL(sourceDatabaseUrl)
  : undefined;
if (testDatabaseUrl) {
  testDatabaseUrl.pathname = `/${testDatabaseName}`;
}
const adminDatabaseUrl = sourceDatabaseUrl
  ? new URL(sourceDatabaseUrl)
  : undefined;
if (adminDatabaseUrl) {
  adminDatabaseUrl.pathname = "/postgres";
}
const databasePackage = fileURLToPath(
  new URL("../../../packages/database", import.meta.url),
);
const quoteIdentifier = (value: string): string =>
  `"${value.replaceAll('"', '""')}"`;

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
let testApp: ReturnType<typeof createApi>;
const profile = loadServerProfileConfig(process.env);

// Sessions come from the database, as with Better Auth: deleting the auth
// user deletes them, so a deleted account is signed out everywhere.
const createAuthStub = (): DotRelayAuth =>
  ({
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const authorization = headers.get("Authorization");
        if (!authorization?.startsWith("Bearer ")) return null;
        const session = await database.authSession.findUnique({
          where: { token: authorization.slice("Bearer ".length) },
          include: { user: true },
        });
        return session ? { user: session.user, session } : null;
      },
    },
    $context: Promise.resolve({
      options: {},
      secretConfig: { secret: "test-secret" },
      internalAdapter: { findAccounts: async () => [] },
    }),
  }) as unknown as DotRelayAuth;

type Person = Readonly<{
  readonly userId: string;
  readonly deviceId: string;
  readonly token: string;
  readonly sessionId: string;
  readonly githubId: string;
  /** The Device's Ed25519 key, which signs an account deletion. */
  readonly signingKey: CryptoKey;
}>;

const createPerson = async (
  label: string,
  options: Readonly<{ sessionAgeMs?: number }> = {},
): Promise<Person> => {
  const authSubject = `auth-${label}-${crypto.randomUUID()}`;
  const githubId = `${Math.floor(Math.random() * 1e9) + 1}`;
  const token = `token-${crypto.randomUUID()}`;
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
      accountId: githubId,
      providerId: "github",
      userId: authSubject,
      accessToken: `gho_${label}_secret`,
    },
  });
  const sessionId = crypto.randomUUID();
  await database.authSession.create({
    data: {
      id: sessionId,
      token,
      userId: authSubject,
      expiresAt: new Date(Date.now() + 3_600_000),
      createdAt: new Date(Date.now() - (options.sessionAgeMs ?? 0)),
    },
  });
  const signing = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const user = await database.user.create({
    data: { serverProfileId: profile.id, authSubject, githubSubject: githubId },
  });
  const x25519PublicKey = crypto.getRandomValues(new Uint8Array(32));
  const device = await database.device.create({
    data: {
      id: crypto.randomUUID(),
      userId: user.id,
      lifecycle: "ACTIVE",
      identityGeneration: 1n,
      keyId: new Uint8Array(await sha384Digest(x25519PublicKey)),
      x25519PublicKey,
      ed25519PublicKey: new Uint8Array(
        await crypto.subtle.exportKey("raw", signing.publicKey),
      ),
      activatedAt: new Date(),
      displayName: `${label} laptop`,
    },
  });
  return {
    userId: user.id,
    deviceId: device.id,
    token,
    sessionId,
    githubId,
    signingKey: signing.privateKey,
  };
};

// The Device's signature over the account deletion command for `operationId`.
const deletionSignature = async (
  person: Person,
  operationId: string,
  userId: string = person.userId,
): Promise<string> => {
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      person.signingKey,
      accountDeletionCommand({ userId, operationId }),
    ),
  );
  return btoa(String.fromCharCode(...signature));
};

const command = async (actorUserId: string, actorDeviceId: string) => {
  const commandBytes = new TextEncoder().encode(crypto.randomUUID());
  return {
    id: crypto.randomUUID(),
    actorUserId,
    actorDeviceId,
    kind: "ADMINISTRATION" as const,
    commandBytes,
    commandDigest: await sha384Digest(commandBytes),
  };
};

const createTeam = async (owner: Person, name: string) => {
  const teamId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  await new AdministrationRepository().createTeamWithOwner(database, {
    teamId,
    serverProfileId: profile.id,
    ownerUserId: owner.userId,
    name,
    operation: await command(owner.userId, owner.deviceId),
  });
  await new ProjectRepository().create(database, {
    teamId,
    projectId,
    githubRepositoryId: BigInt(Math.floor(Math.random() * 1e9) + 1),
    operation: await command(owner.userId, owner.deviceId),
  });
  return { teamId, projectId };
};

const join = (teamId: string, person: Person) =>
  database.membership.create({
    data: {
      teamId,
      userId: person.userId,
      lifecycle: "ACTIVE",
      activatedAt: new Date(),
    },
  });

const request = async (
  person: Person,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  withDevice = false,
  operationId: string = crypto.randomUUID(),
) =>
  testApp.request(`${profile.origin}${path}`, {
    method,
    headers: {
      Origin: profile.origin,
      Authorization: `Bearer ${person.token}`,
      // A Device-scoped request proves the Device (ADR 0020).
      ...(withDevice
        ? {
            "X-DotRelay-Device-Id": person.deviceId,
            "X-DotRelay-Device-Proof": await testDeviceProof(profile, {
              sessionId: person.sessionId,
              userId: person.userId,
              deviceId: person.deviceId,
            }),
          }
        : {}),
      ...(method === "POST"
        ? {
            "Content-Type": "application/json",
            "Idempotency-Key": operationId,
          }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const problemCode = async (response: Response) =>
  ((await response.json()) as { code?: string }).code;

integrationDescribe("account and Team lifecycle routes (PostgreSQL)", () => {
  beforeAll(async () => {
    if (!adminDatabaseUrl) throw new Error("DATABASE_URL is required");
    if (!testDatabaseUrl) throw new Error("DATABASE_URL is required");
    database = createDatabaseClient(testDatabaseUrl.toString());
    const admin = new Client({ connectionString: adminDatabaseUrl.toString() });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(testDatabaseName)}`);
    } finally {
      await admin.end();
    }
    await runMigrations();
    await ensureServerProfile(database, {
      id: profile.id,
      origin: profile.origin,
      allowRebind: profile.allowRebind,
    });
    testApp = createApi({ database, profile, auth: createAuthStub() });
  }, INTEGRATION_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await database.$disconnect();
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
  }, INTEGRATION_HOOK_TIMEOUT_MS);

  test("a Member leaves and owes a rotation; the last owner cannot", async () => {
    const owner = await createPerson("leave-owner");
    const member = await createPerson("leave-member");
    const { teamId, projectId } = await createTeam(owner, "leave-team");
    await join(teamId, member);

    const ownerLeave = await request(
      owner,
      "POST",
      `/api/v1/teams/${teamId}/leave`,
      {},
      true,
    );
    expect(ownerLeave.status).toBe(409);
    expect(await problemCode(ownerLeave)).toBe("owner_transfer_required");

    // A session alone cannot make a User with an active Device leave.
    const sessionOnly = await request(
      member,
      "POST",
      `/api/v1/teams/${teamId}/leave`,
      {},
    );
    expect(sessionOnly.status).toBe(401);
    expect(await problemCode(sessionOnly)).toBe("device_proof_required");

    const left = await request(
      member,
      "POST",
      `/api/v1/teams/${teamId}/leave`,
      {},
      true,
    );
    expect(left.status).toBe(201);
    expect(await left.json()).toMatchObject({ teamId, lifecycle: "REMOVED" });
    expect(
      await database.projectRotationObligation.count({
        where: { projectId, reason: "MEMBERSHIP_REMOVED", clearedAt: null },
      }),
    ).toBe(1);
    const again = await request(
      member,
      "POST",
      `/api/v1/teams/${teamId}/leave`,
      {},
      true,
    );
    expect(await problemCode(again)).toBe("membership_not_active");
  });

  test("an owner deletes a Team; nobody can read it afterwards", async () => {
    const owner = await createPerson("delete-owner");
    const member = await createPerson("delete-member");
    const { teamId, projectId } = await createTeam(owner, "doomed-team");
    await join(teamId, member);

    const byMember = await request(
      member,
      "POST",
      `/api/v1/teams/${teamId}/delete`,
      { confirmName: "doomed-team" },
      true,
    );
    expect(byMember.status).toBe(403);
    const wrongName = await request(
      owner,
      "POST",
      `/api/v1/teams/${teamId}/delete`,
      { confirmName: "doomed" },
      true,
    );
    expect(await problemCode(wrongName)).toBe("invalid_request");
    const deleted = await request(
      owner,
      "POST",
      `/api/v1/teams/${teamId}/delete`,
      { confirmName: "doomed-team" },
      true,
    );
    expect(deleted.status).toBe(201);
    expect(await deleted.json()).toMatchObject({ teamId, status: "DELETED" });

    for (const person of [owner, member]) {
      const environments = await request(
        person,
        "GET",
        `/api/v1/projects/${projectId}/environments`,
        undefined,
        true,
      );
      expect(environments.ok).toBe(false);
      const teams = (await (
        await request(person, "GET", "/api/v1/teams", undefined, true)
      ).json()) as { teams: Array<{ id: string }> };
      expect(teams.teams.map((team) => team.id)).not.toContain(teamId);
    }
  });

  test("exports account metadata without secrets and deletes the account", async () => {
    const owner = await createPerson("account-owner");
    const member = await createPerson("account-member");
    const { teamId } = await createTeam(owner, "account-team");
    await join(teamId, member);
    const solo = await createTeam(member, "member-solo-team");

    const exported = await request(
      member,
      "GET",
      "/api/v1/account/export",
      undefined,
      true,
    );
    expect(exported.status).toBe(200);
    expect(exported.headers.get("Content-Disposition")).toContain("attachment");
    const exportText = await exported.text();
    const exportBody = JSON.parse(exportText) as Record<string, unknown>;
    expect(exportBody.format).toBe("dotrelay-account-export-v1");
    expect(exportText).not.toContain("gho_account-member_secret");
    expect(exportText).not.toContain(member.token);
    expect(exportText).toContain("account-member laptop");

    // The owner is the last owner of a Team with another Member.
    const plan = await request(owner, "GET", "/api/v1/account/deletion");
    expect(await plan.json()).toMatchObject({
      blockingTeams: [{ teamId, name: "account-team" }],
    });
    const signedDeletion = async (
      person: Person,
      confirmUserId: string = person.userId,
    ) => {
      const operationId = crypto.randomUUID();
      return request(
        person,
        "POST",
        "/api/v1/account/delete",
        {
          confirmUserId,
          signature: await deletionSignature(
            person,
            operationId,
            confirmUserId,
          ),
        },
        true,
        operationId,
      );
    };
    const blocked = await signedDeletion(owner);
    expect(await problemCode(blocked)).toBe("owner_transfer_required");

    const wrong = await signedDeletion(member, owner.userId);
    expect(await problemCode(wrong)).toBe("invalid_request");
    const deleted = await signedDeletion(member);
    expect(deleted.status).toBe(201);
    expect(await deleted.json()).toMatchObject({
      status: "DELETED",
      teamsDeleted: [{ teamId: solo.teamId, name: "member-solo-team" }],
      teamsLeft: [{ teamId, name: "account-team" }],
    });

    // Every session ended with the account.
    const after = await request(
      member,
      "GET",
      "/api/v1/account/export",
      undefined,
      true,
    );
    expect(after.status).toBe(401);

    // Teammates still see the departed Member, marked deleted.
    const members = (await (
      await request(owner, "GET", `/api/v1/teams/${teamId}/memberships`)
    ).json()) as {
      memberships: Array<{ userId: string; deleted?: boolean; name: unknown }>;
    };
    expect(
      members.memberships.find((entry) => entry.userId === member.userId),
    ).toMatchObject({ deleted: true, name: null });
  });
  test("a session alone cannot delete or export an account that has an active Device", async () => {
    const victim = await createPerson("session-only");
    const deletion = { confirmUserId: victim.userId };
    for (const [method, path, body] of [
      ["POST", "/api/v1/account/delete", deletion],
      ["GET", "/api/v1/account/export", undefined],
    ] as const) {
      const refused = await request(victim, method, path, body);
      expect(refused.status).toBe(401);
      expect(await problemCode(refused)).toBe("device_proof_required");
    }
    // A Device proof is not enough: deletion needs the Device's signature
    // over this exact command.
    const unsigned = await request(
      victim,
      "POST",
      "/api/v1/account/delete",
      deletion,
      true,
    );
    expect(await problemCode(unsigned)).toBe("invalid_request");
    const operationId = crypto.randomUUID();
    const replayed = await request(
      victim,
      "POST",
      "/api/v1/account/delete",
      {
        ...deletion,
        // Signed for another operation.
        signature: await deletionSignature(victim, crypto.randomUUID()),
      },
      true,
      operationId,
    );
    expect(await problemCode(replayed)).toBe("invalid_crypto_object");
    const user = await database.user.findUnique({
      where: { id: victim.userId },
      select: { deletedAt: true },
    });
    expect(user?.deletedAt).toBeNull();
    expect(
      await database.device.count({
        where: { userId: victim.userId, lifecycle: "ACTIVE" },
      }),
    ).toBe(1);
  });

  test("an account without an active Device needs a recent sign-in", async () => {
    const stale = await createPerson("stale-session", {
      sessionAgeMs: 20 * 60_000,
    });
    const fresh = await createPerson("fresh-session");
    for (const person of [stale, fresh])
      await database.device.update({
        where: { id: person.deviceId },
        data: { lifecycle: "REVOKED", revokedAt: new Date() },
      });
    const staleExport = await request(stale, "GET", "/api/v1/account/export");
    expect(staleExport.status).toBe(403);
    expect(await problemCode(staleExport)).toBe("recent_sign_in_required");
    const staleDelete = await request(stale, "POST", "/api/v1/account/delete", {
      confirmUserId: stale.userId,
    });
    expect(await problemCode(staleDelete)).toBe("recent_sign_in_required");

    expect((await request(fresh, "GET", "/api/v1/account/export")).status).toBe(
      200,
    );
    const deleted = await request(fresh, "POST", "/api/v1/account/delete", {
      confirmUserId: fresh.userId,
    });
    expect(deleted.status).toBe(201);
  });
});
