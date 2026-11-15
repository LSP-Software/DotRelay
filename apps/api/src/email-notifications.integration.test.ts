import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  AdministrationRepository,
  createDatabaseClient,
  ensureServerProfile,
  type DatabaseClient,
  sha384Digest,
} from "@dotrelay/database";
import type { DotRelayAuth } from "./auth";
import { testDeviceProof } from "./device-proof-testing";
import { type EmailMessage, EmailSendError } from "./email";
import { createEmailNotifier } from "./email-notifications";
import { createInMemoryDiagnosticSink } from "./observability";
import { createApi } from "./index";
import { loadServerProfileConfig } from "./profile";

const integrationDescribe = process.env.DATABASE_URL ? describe : describe.skip;
const INTEGRATION_HOOK_TIMEOUT_MS = 30_000;
const sourceDatabaseUrl = process.env.DATABASE_URL;
const testDatabaseName = `dotrelay_email_${crypto
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
const sent: EmailMessage[] = [];
let failNextSends = 0;
let notifier: ReturnType<typeof createEmailNotifier>;
const diagnostics = createInMemoryDiagnosticSink();
const profile = loadServerProfileConfig(process.env);
const OWNER_TOKEN = "owner-token";
const INVITEE_TOKEN = "invitee-token";
const authSubject = `auth-email-owner-${crypto.randomUUID()}`;
const inviteeAuthSubject = `auth-email-invitee-${crypto.randomUUID()}`;
const ownerEmail = `owner-${crypto.randomUUID()}@example.test`;
const inviteeEmail = `invitee-${crypto.randomUUID()}@example.test`;

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
        const token = authorization.slice("Bearer ".length);
        if (token === OWNER_TOKEN)
          return { session: { id: token }, user: { id: authSubject } };
        if (token === INVITEE_TOKEN)
          return { session: { id: token }, user: { id: inviteeAuthSubject } };
        return null;
      },
    },
    $context: Promise.resolve({
      options: {},
      secretConfig: { secret: "test-secret" },
      internalAdapter: { findAccounts: async () => [] },
    }),
  }) as unknown as DotRelayAuth;

const post = async (
  path: string,
  token: string,
  idempotencyKey: string,
  body?: unknown,
) =>
  testApp.request(`${profile.origin}${path}`, {
    method: "POST",
    headers: {
      Origin: profile.origin,
      "Cache-Control": "no-store",
      Authorization: `Bearer ${token}`,
      // The owner's commands are Device-scoped and prove the Device
      // (ADR 0020); the invitee accepts with the session alone.
      ...(token === OWNER_TOKEN
        ? {
            "X-DotRelay-Device-Id": deviceId,
            "X-DotRelay-Device-Proof": await testDeviceProof(profile, {
              sessionId: OWNER_TOKEN,
              userId: ownerUserId,
              deviceId,
            }),
          }
        : {}),
      "Idempotency-Key": idempotencyKey,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

integrationDescribe("transactional email after commit (PostgreSQL)", () => {
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
    for (const [id, name, email, githubId] of [
      [authSubject, "Olive Owner", ownerEmail, "3001"],
      [inviteeAuthSubject, "Ivy <Invitee>", inviteeEmail, "3002"],
    ] as const) {
      await database.authUser.create({ data: { id, name, email } });
      await database.authAccount.create({
        data: {
          id: crypto.randomUUID(),
          accountId: githubId,
          providerId: "github",
          userId: id,
        },
      });
    }
    const owner = await database.user.create({
      data: { serverProfileId: profile.id, authSubject, githubSubject: "3001" },
    });
    ownerUserId = owner.id;
    // The invitee has signed in before, so a stored address exists.
    await database.user.create({
      data: {
        serverProfileId: profile.id,
        authSubject: inviteeAuthSubject,
        githubSubject: "3002",
      },
    });
    const x25519PublicKey = crypto.getRandomValues(new Uint8Array(32));
    deviceId = (
      await database.device.create({
        data: {
          id: crypto.randomUUID(),
          userId: owner.id,
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
    const teamCommand = new TextEncoder().encode("email-team");
    await new AdministrationRepository().createTeamWithOwner(database, {
      teamId,
      serverProfileId: profile.id,
      ownerUserId: owner.id,
      name: "Ops & <Friends>",
      operation: {
        id: crypto.randomUUID(),
        actorUserId: owner.id,
        actorDeviceId: deviceId,
        kind: "ADMINISTRATION",
        commandBytes: teamCommand,
        commandDigest: await sha384Digest(teamCommand),
      },
    });
    notifier = createEmailNotifier({
      database,
      profile,
      config: {
        apiKey: "re_fixture",
        from: "DotRelay <noreply@dotrelay.dev>",
        supportAddress: "support@dotrelay.dev",
      },
      transport: {
        send: async (message) => {
          if (failNextSends > 0) {
            failNextSends -= 1;
            throw new EmailSendError("server_error");
          }
          sent.push(message);
        },
      },
      diagnostics,
      sleep: async () => undefined,
    });
    testApp = createApi({
      database,
      profile,
      auth: createAuthStub(),
      notifications: notifier,
    });
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

  test("invite and accept email the invitee, then the owner, from committed rows", async () => {
    const invite = await post(
      `/api/v1/teams/${teamId}/invitations`,
      OWNER_TOKEN,
      crypto.randomUUID(),
      { providerSubject: "3002" },
    );
    expect(invite.status).toBe(201);
    const { invitationId } = (await invite.json()) as { invitationId: string };
    await notifier.drain();
    expect(sent.map((message) => message.to)).toEqual([inviteeEmail]);
    expect(sent[0]?.text).toContain("Olive Owner invited you");
    expect(sent[0]?.html).toContain("Ops &amp; &lt;Friends&gt;");

    // An invitee who never signed in has no stored address: no email.
    const unknown = await post(
      `/api/v1/teams/${teamId}/invitations`,
      OWNER_TOKEN,
      crypto.randomUUID(),
      { providerSubject: "3999" },
    );
    expect(unknown.status).toBe(201);
    await notifier.drain();
    expect(sent).toHaveLength(1);

    // A failed send does not fail the acceptance, and is retried once.
    failNextSends = 1;
    const accept = await post(
      `/api/v1/invitations/${invitationId}/accept`,
      INVITEE_TOKEN,
      crypto.randomUUID(),
    );
    expect(accept.status).toBe(201);
    const { membershipId } = (await accept.json()) as {
      membershipId: string;
    };
    await notifier.drain();
    expect(sent.map((message) => message.to)).toEqual([
      inviteeEmail,
      ownerEmail,
    ]);
    const accepted = await database.membership.findUnique({
      where: { id: membershipId },
      select: { userId: true },
    });
    expect(sent[1]?.text).toContain("Ivy <Invitee> joined");
    expect(sent[1]?.text).toContain(
      `dotrelay team share-keys ${accepted?.userId} --team ${teamId}`,
    );
    expect(ownerUserId).not.toBe(accepted?.userId);
    const serialized = JSON.stringify(diagnostics.records());
    expect(serialized).not.toContain("@");
    expect(serialized).not.toContain("Ops");
  }, 30_000);

  test("a rolled-back command sends nothing", async () => {
    const before = sent.length;
    const response = await post(
      `/api/v1/teams/${crypto.randomUUID()}/invitations`,
      OWNER_TOKEN,
      crypto.randomUUID(),
      { providerSubject: "3002" },
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    await notifier.drain();
    expect(sent).toHaveLength(before);
  });
});
