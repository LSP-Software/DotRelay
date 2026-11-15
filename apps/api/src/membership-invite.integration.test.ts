import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  AdministrationRepository,
  createDatabaseClient,
  ensureServerProfile,
  type DatabaseClient,
  MembershipAdministrationRepository,
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
const testDatabaseName = `dotrelay_invite_${crypto
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
let teamId = "";
let deviceId = "";
let ownerUserId = "";
const profile = loadServerProfileConfig(process.env);
const OWNER_TOKEN = "owner-token";
const authSubject = `auth-invite-${crypto.randomUUID()}`;

const createAuthStub = (): DotRelayAuth =>
  ({
    api: {
      getSession: async ({
        headers,
      }: {
        headers: Headers;
      }): Promise<null | {
        session: { id: string };
        user: { id: string };
      }> => {
        const authorization = headers.get("Authorization");
        if (!authorization?.startsWith("Bearer ")) return null;
        return authorization.slice("Bearer ".length) === OWNER_TOKEN
          ? { session: { id: OWNER_TOKEN }, user: { id: authSubject } }
          : null;
      },
    },
    $context: Promise.resolve({
      options: {},
      secretConfig: { secret: "test-secret" },
      internalAdapter: { findAccounts: async () => [] },
    }),
  }) as unknown as DotRelayAuth;

// The owner Device's proof (ADR 0020) for the owner's session.
const ownerProof = async () => ({
  "X-DotRelay-Device-Id": deviceId,
  "X-DotRelay-Device-Proof": await testDeviceProof(profile, {
    sessionId: OWNER_TOKEN,
    userId: ownerUserId,
    deviceId,
  }),
});

const inviteRequest = async (idempotencyKey: string, providerSubject: string) =>
  testApp.request(`${profile.origin}/api/v1/teams/${teamId}/invitations`, {
    method: "POST",
    headers: {
      Origin: profile.origin,
      "Cache-Control": "no-store",
      Authorization: `Bearer ${OWNER_TOKEN}`,
      ...(await ownerProof()),
      "Idempotency-Key": idempotencyKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ providerSubject }),
  });

integrationDescribe(
  "team invitation re-invite through the API (PostgreSQL)",
  () => {
    beforeAll(async () => {
      if (!adminDatabaseUrl) throw new Error("DATABASE_URL is required");
      if (!testDatabaseUrl) throw new Error("DATABASE_URL is required");
      database = createDatabaseClient(testDatabaseUrl.toString());
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
      await ensureServerProfile(database, {
        id: profile.id,
        origin: profile.origin,
        allowRebind: profile.allowRebind,
      });
      const x25519PublicKey = crypto.getRandomValues(new Uint8Array(32));
      const user = await database.user.create({
        data: {
          serverProfileId: profile.id,
          authSubject,
          githubSubject: "1001",
        },
      });
      ownerUserId = user.id;
      await database.authUser.create({
        data: {
          id: authSubject,
          name: "Invitation Owner",
          email: `invite-${crypto.randomUUID()}@example.test`,
        },
      });
      await database.authAccount.create({
        data: {
          id: crypto.randomUUID(),
          accountId: "1001",
          providerId: "github",
          userId: authSubject,
        },
      });
      deviceId = (
        await database.device.create({
          data: {
            id: crypto.randomUUID(),
            userId: user.id,
            lifecycle: "ACTIVE",
            identityGeneration: 1n,
            keyId: new Uint8Array(await sha384Digest(x25519PublicKey)),
            x25519PublicKey,
            ed25519PublicKey: crypto.getRandomValues(new Uint8Array(32)),
            activatedAt: new Date(),
          },
        })
      ).id;
      teamId = crypto.randomUUID();
      const teamCommand = new TextEncoder().encode("invite-team");
      await new AdministrationRepository().createTeamWithOwner(database, {
        teamId,
        serverProfileId: profile.id,
        ownerUserId: user.id,
        name: "invite-reproduction",
        operation: {
          id: crypto.randomUUID(),
          actorUserId: user.id,
          actorDeviceId: deviceId,
          kind: "ADMINISTRATION",
          commandBytes: teamCommand,
          commandDigest: await sha384Digest(teamCommand),
        },
      });
      testApp = createApi({
        database,
        profile,
        auth: createAuthStub(),
      });
    }, INTEGRATION_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await database.$disconnect();
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
    }, INTEGRATION_HOOK_TIMEOUT_MS);

    test("an owner re-invites the same subject with a fresh Idempotency-Key", async () => {
      const keyOne = "f0000000-0000-4000-8000-0000000000a1";
      const keyTwo = "f0000000-0000-4000-8000-0000000000a2";
      const providerSubject = "918273645";

      const first = await inviteRequest(keyOne, providerSubject);
      expect(first.status).toBe(201);
      const firstBody = (await first.json()) as Record<string, unknown>;
      expect(firstBody.teamId).toBe(teamId);
      expect(firstBody.providerSubject).toBe(providerSubject);

      // The same Idempotency-Key is a replay of the original command, not a
      // new invitation: byte-stable digest, committed operation, 200.
      const replay = await inviteRequest(keyOne, providerSubject);
      expect(replay.status).toBe(200);
      const replayBody = (await replay.json()) as Record<string, unknown>;
      expect(replayBody.invitationId).toBe(firstBody.invitationId);

      // The same owner re-inviting the same subject with a fresh key is a new
      // command: distinct digest, new invitation, 201 (was 409 before the fix).
      const second = await inviteRequest(keyTwo, providerSubject);
      expect(second.status).toBe(201);
      const secondBody = (await second.json()) as Record<string, unknown>;
      expect(secondBody.invitationId).not.toBe(firstBody.invitationId);
      const invitations = await database.membershipInvitation.findMany({
        where: { teamId, providerSubject },
        select: { id: true },
      });
      expect(invitations).toHaveLength(2);

      const operationOne = await database.operation.findUnique({
        where: { id: keyOne },
      });
      const operationTwo = await database.operation.findUnique({
        where: { id: keyTwo },
      });
      expect(operationOne?.status).toBe("COMMITTED");
      expect(operationTwo?.status).toBe("COMMITTED");
      const digestOne = Buffer.from(
        operationOne?.commandDigest ?? new Uint8Array(),
      ).toString("base64");
      const digestTwo = Buffer.from(
        operationTwo?.commandDigest ?? new Uint8Array(),
      ).toString("base64");
      expect(digestOne).not.toBe(digestTwo);
      // The first operation's digest is computed over the command bytes that
      // bind the execution to its Idempotency-Key.
      const expectedOne = await sha384Digest(
        new TextEncoder().encode(
          JSON.stringify({
            action: "team.invite",
            teamId,
            providerSubject,
            operationId: keyOne,
          }),
        ),
      );
      expect(digestOne).toBe(Buffer.from(expectedOne).toString("base64"));

      // Now that B exists, each key's replay still reports the invitation its
      // own operation created, not the newest invitation the subject holds.
      const replayOne = await inviteRequest(keyOne, providerSubject);
      expect(replayOne.status).toBe(200);
      const replayOneBody = (await replayOne.json()) as Record<string, unknown>;
      expect(replayOneBody.invitationId).toBe(firstBody.invitationId);
      const replayTwo = await inviteRequest(keyTwo, providerSubject);
      expect(replayTwo.status).toBe(200);
      const replayTwoBody = (await replayTwo.json()) as Record<string, unknown>;
      expect(replayTwoBody.invitationId).toBe(secondBody.invitationId);
    }, 30_000);

    const operation = async (actorUserId: string, label: string) => {
      const commandBytes = new TextEncoder().encode(
        `${label}-${crypto.randomUUID()}`,
      );
      return {
        id: crypto.randomUUID(),
        actorUserId,
        kind: "ADMINISTRATION" as const,
        commandBytes,
        commandDigest: await sha384Digest(commandBytes),
      };
    };

    test("a removed and re-invited Member keeps every period in the signing trust, and removal owes a rotation", async () => {
      const githubRepositoryId = BigInt(Date.now());
      await new ProjectRepository().create(database, {
        teamId,
        githubRepositoryId,
        operation: {
          ...(await operation(ownerUserId, "history-project")),
          actorDeviceId: deviceId,
        },
      });
      const inviteeKey = crypto.getRandomValues(new Uint8Array(32));
      const invitee = await database.user.create({
        data: {
          serverProfileId: profile.id,
          authSubject: `auth-history-${crypto.randomUUID()}`,
          githubSubject: "5150",
        },
      });
      const inviteeDevice = await database.device.create({
        data: {
          id: crypto.randomUUID(),
          userId: invitee.id,
          lifecycle: "ACTIVE",
          identityGeneration: 1n,
          keyId: new Uint8Array(await sha384Digest(inviteeKey)),
          x25519PublicKey: inviteeKey,
          ed25519PublicKey: crypto.getRandomValues(new Uint8Array(32)),
          activatedAt: new Date(Date.now() - 60 * 24 * 60 * 60_000),
        },
      });
      const memberships = new MembershipAdministrationRepository();
      const join = async (label: string) => {
        const invited = await memberships.invite(database, {
          teamId,
          providerSubject: "5150",
          operation: {
            ...(await operation(ownerUserId, `${label}-invite`)),
            actorDeviceId: deviceId,
          },
        });
        if (!("invitation" in invited)) throw new Error("invite replayed");
        const accepted = await memberships.accept(database, {
          invitationId: invited.invitation.id,
          userId: invitee.id,
          operation: await operation(invitee.id, `${label}-accept`),
        });
        if (!("membership" in accepted)) throw new Error("accept replayed");
        // Key provisioning is covered elsewhere; activate directly.
        return database.membership.update({
          where: { id: accepted.membership.id },
          data: { lifecycle: "ACTIVE", activatedAt: new Date() },
        });
      };
      const first = await join("history-first");
      const removed = await memberships.remove(database, {
        teamId,
        membershipId: first.id,
        operation: {
          ...(await operation(ownerUserId, "history-remove")),
          actorDeviceId: deviceId,
        },
      });
      if (!("membership" in removed)) throw new Error("removal replayed");
      const second = await join("history-second");

      const response = await testApp.request(
        `${profile.origin}/api/v1/workspace/boundary?githubRepositoryId=${githubRepositoryId}`,
        {
          headers: {
            Origin: profile.origin,
            Authorization: `Bearer ${OWNER_TOKEN}`,
            ...(await ownerProof()),
          },
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        environment: { rotationOwed: Record<string, unknown> | null };
        rotationRequired: boolean;
        signingTrustDevices: Array<Record<string, unknown>>;
      };
      const entry = body.signingTrustDevices.find(
        (candidate) => candidate.deviceId === inviteeDevice.id,
      );
      expect(entry?.memberSinceMs).toBe(second.activatedAt?.getTime());
      expect(entry?.membershipPeriods).toEqual([
        {
          sinceMs: first.activatedAt?.getTime(),
          untilMs: removed.membership.removedAt?.getTime(),
        },
        { sinceMs: second.activatedAt?.getTime(), untilMs: null },
      ]);
      expect(body.environment.rotationOwed).toMatchObject({
        sinceEpoch: "1",
        membershipRemovals: 1,
        deviceRevocations: 0,
      });
      expect(body.rotationRequired).toBe(false);
    }, 30_000);

    test("an owner revokes an invitation over HTTP and it stops being pending", async () => {
      const created = await inviteRequest(
        "f0000000-0000-4000-8000-0000000000b1",
        "777000",
      );
      const { invitationId } = (await created.json()) as {
        invitationId: string;
      };
      const revoke = await testApp.request(
        `${profile.origin}/api/v1/teams/${teamId}/invitations/${invitationId}/revoke`,
        {
          method: "POST",
          headers: {
            Origin: profile.origin,
            Authorization: `Bearer ${OWNER_TOKEN}`,
            ...(await ownerProof()),
            "Idempotency-Key": "f0000000-0000-4000-8000-0000000000b2",
            "Content-Type": "application/json",
          },
          body: "{}",
        },
      );
      expect(revoke.status).toBe(201);
      const row = await database.membershipInvitation.findUniqueOrThrow({
        where: { id: invitationId },
      });
      expect(row.revokedAt).toBeInstanceOf(Date);
      expect(
        await database.auditEvent.count({
          where: { entityId: invitationId, kind: "INVITATION_REVOKED" },
        }),
      ).toBe(1);
    }, 30_000);
  },
);
