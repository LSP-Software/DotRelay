import { describe, expect, test } from "bun:test";
import { sha384Digest } from "@dotrelay/database";
import type { DotRelayAuth } from "./auth";
import { createApi } from "./index";
import { loadServerProfileConfig } from "./profile";

const TEAM_A = "11111111-1111-4111-8111-111111111111";
const TEAM_B = "22222222-2222-4222-8222-222222222222";
const USER_OWNER = "33333333-3333-4333-8333-333333333333";
const USER_ADMIN = "34343434-3434-4434-8434-343434343434";
const USER_MEMBER = "44444444-4444-4444-8444-444444444444";
const USER_B = "55555555-5555-4555-8555-555555555555";
const DEVICE_OWNER = "88888888-8888-4888-8888-888888888888";
const DEVICE_ADMIN = "89898989-8989-4989-8989-898989898989";
const DEVICE_MEMBER = "90909090-9090-4990-8990-909090909090";
const DEVICE_INACTIVE = "91919191-9191-4991-8991-919191919191";
const PROJECT_A = "a1111111-a111-4111-8111-a11111111111";
const PROJECT_A2 = "a2222222-a222-4222-8222-a22222222222";
const PROJECT_B = "a3333333-a333-4333-8333-a33333333333";
const ENV_A = "b1111111-b111-4111-8111-b11111111111";
const ENV_A2 = "b2222222-b222-4222-8222-b22222222222";
const ENV_A3 = "b3333333-b333-4333-8333-b33333333333";
const ENV_B = "b4444444-b444-4444-8444-b44444444444";

const profile = loadServerProfileConfig({});

type StubMembership = {
  teamId: string;
  userId: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
  lifecycle: "ACTIVE" | "PENDING_KEY_GRANT" | "REMOVED";
};

const users = [
  {
    id: USER_OWNER,
    serverProfileId: profile.id,
    authSubject: "auth-owner",
    githubSubject: "1001",
  },
  {
    id: USER_ADMIN,
    serverProfileId: profile.id,
    authSubject: "auth-admin",
    githubSubject: "2002",
  },
  {
    id: USER_MEMBER,
    serverProfileId: profile.id,
    authSubject: "auth-member",
    githubSubject: "3003",
  },
  {
    id: USER_B,
    serverProfileId: profile.id,
    authSubject: "auth-b",
    githubSubject: "4004",
  },
];

const authAccounts = [
  { userId: "auth-owner", providerId: "github", accountId: "1001" },
  { userId: "auth-admin", providerId: "github", accountId: "2002" },
  { userId: "auth-member", providerId: "github", accountId: "3003" },
  { userId: "auth-b", providerId: "github", accountId: "4004" },
];

const authUsers = [
  { id: "auth-owner", name: "Owner Person", image: null },
  { id: "auth-admin", name: "Admin Person", image: null },
  { id: "auth-member", name: "Member Person", image: null },
  { id: "auth-b", name: "Beta Owner", image: null },
];

const devices = [
  { id: DEVICE_OWNER, userId: USER_OWNER, lifecycle: "ACTIVE" },
  { id: DEVICE_ADMIN, userId: USER_ADMIN, lifecycle: "ACTIVE" },
  { id: DEVICE_MEMBER, userId: USER_MEMBER, lifecycle: "ACTIVE" },
  { id: DEVICE_INACTIVE, userId: USER_OWNER, lifecycle: "ARCHIVED" },
];

const memberships: StubMembership[] = [
  { teamId: TEAM_A, userId: USER_OWNER, role: "OWNER", lifecycle: "ACTIVE" },
  { teamId: TEAM_A, userId: USER_ADMIN, role: "ADMIN", lifecycle: "ACTIVE" },
  { teamId: TEAM_A, userId: USER_MEMBER, role: "MEMBER", lifecycle: "ACTIVE" },
  { teamId: TEAM_B, userId: USER_B, role: "OWNER", lifecycle: "ACTIVE" },
];

const sessions = new Map<string, string>([
  ["owner-token", "auth-owner"],
  ["admin-token", "auth-admin"],
  ["member-token", "auth-member"],
  ["b-token", "auth-b"],
]);

const createAuthStub = (): DotRelayAuth =>
  ({
    api: {
      getSession: async ({
        headers,
      }: {
        headers: Headers;
      }): Promise<null | { user: { id: string } }> => {
        const authorization = headers.get("Authorization");
        if (!authorization?.startsWith("Bearer ")) return null;
        const userId = sessions.get(authorization.slice("Bearer ".length));
        return userId === undefined ? null : { user: { id: userId } };
      },
    },
  }) as unknown as DotRelayAuth;

const createDatabaseStub = () => {
  const projects = [
    {
      id: PROJECT_A,
      teamId: TEAM_A,
      githubRepositoryId: 884193201n,
      lifecycle: "ACTIVE",
      archivedAt: null,
    },
    {
      id: PROJECT_A2,
      teamId: TEAM_A,
      githubRepositoryId: 102938475n,
      lifecycle: "ARCHIVED",
      archivedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    {
      id: PROJECT_B,
      teamId: TEAM_B,
      githubRepositoryId: 200000000n,
      lifecycle: "ACTIVE",
      archivedAt: null,
    },
  ];
  const environments = [
    {
      id: ENV_A,
      projectId: PROJECT_A,
      label: "production",
      lifecycle: "ACTIVE",
      archivedAt: null,
      currentHeadId: "rev_0184",
    },
    {
      id: ENV_A2,
      projectId: PROJECT_A,
      label: "staging",
      lifecycle: "ARCHIVED",
      archivedAt: new Date("2026-01-02T00:00:00.000Z"),
      currentHeadId: "rev_0102",
    },
    {
      id: ENV_A3,
      projectId: PROJECT_A2,
      label: "default",
      lifecycle: "ARCHIVED",
      archivedAt: new Date("2026-01-03T00:00:00.000Z"),
      currentHeadId: null,
    },
    {
      id: ENV_B,
      projectId: PROJECT_B,
      label: "default",
      lifecycle: "ACTIVE",
      archivedAt: null,
      currentHeadId: null,
    },
  ];
  const operations = new Map<
    string,
    {
      id: string;
      actorUserId: string;
      actorDeviceId: string | null;
      kind: string;
      commandDigest: Uint8Array;
      status: "STAGED" | "COMMITTED";
    }
  >();
  const auditEvents: Array<Record<string, unknown>> = [];

  const database = {
    $transaction: async (
      callback: (transaction: unknown) => Promise<unknown>,
    ) => callback(database),
    $executeRaw: async () => 0,
    authAccount: {
      findFirst: async ({
        where,
      }: {
        where: { userId: string; providerId: string };
      }) =>
        authAccounts.find(
          (account) =>
            account.userId === where.userId &&
            account.providerId === where.providerId,
        ) ?? null,
    },
    user: {
      upsert: async ({
        where,
      }: {
        where: {
          serverProfileId_authSubject: {
            serverProfileId: string;
            authSubject: string;
          };
        };
      }) =>
        users.find(
          (user) =>
            user.authSubject === where.serverProfileId_authSubject.authSubject,
        ) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) =>
        users.find((user) => user.id === where.id) ?? null,
    },
    device: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; userId: string; lifecycle: string };
      }) =>
        devices.find(
          (device) =>
            device.id === where.id &&
            device.userId === where.userId &&
            device.lifecycle === where.lifecycle,
        ) ?? null,
    },
    membership: {
      findFirst: async ({
        where,
      }: {
        where: { teamId?: string; userId?: string };
      }) =>
        memberships.find(
          (membership) =>
            (where.teamId === undefined ||
              membership.teamId === where.teamId) &&
            (where.userId === undefined || membership.userId === where.userId),
        ) ?? null,
    },
    project: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        projects.find((project) => project.id === where.id) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const project = projects.find((entry) => entry.id === where.id);
        if (!project) throw new Error("Project not found");
        Object.assign(project, data);
        return project;
      },
    },
    environment: {
      findUnique: async ({
        where,
        include,
      }: {
        where: { id: string };
        include?: { project?: boolean };
      }) => {
        const environment = environments.find((entry) => entry.id === where.id);
        if (!environment) return null;
        return {
          ...environment,
          ...(include?.project
            ? {
                project:
                  projects.find(
                    (project) => project.id === environment.projectId,
                  ) ?? null,
              }
            : {}),
        };
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const environment = environments.find((entry) => entry.id === where.id);
        if (!environment) throw new Error("Environment not found");
        Object.assign(environment, data);
        return environment;
      },
    },
    operation: {
      createMany: async ({
        data,
      }: {
        data: Array<{
          id: string;
          actorUserId: string;
          actorDeviceId?: string;
          kind: string;
          commandDigest: Uint8Array;
        }>;
        skipDuplicates?: boolean;
      }) => {
        for (const entry of data) {
          if (operations.has(entry.id)) continue;
          operations.set(entry.id, {
            id: entry.id,
            actorUserId: entry.actorUserId,
            actorDeviceId: entry.actorDeviceId ?? null,
            kind: entry.kind,
            commandDigest: entry.commandDigest,
            status: "STAGED",
          });
        }
        return { count: data.length };
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        operations.get(where.id) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { status?: string; committedAt?: Date };
      }) => {
        const operation = operations.get(where.id);
        if (!operation) throw new Error("Operation not found");
        if (data.status) operation.status = data.status as "COMMITTED";
        return { count: 1 };
      },
    },
    auditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        auditEvents.push(data);
        return data;
      },
    },
  };
  return { database, operations, auditEvents, projects, environments };
};

const createTestApp = () => {
  const { database, operations, auditEvents, projects, environments } =
    createDatabaseStub();
  const testApp = createApi({
    database: database as never,
    profile,
    auth: createAuthStub(),
  });
  return { testApp, operations, auditEvents, projects, environments };
};

const request = (
  testApp: ReturnType<typeof createTestApp>["testApp"],
  path: string,
  options: {
    method?: string;
    token?: string;
    deviceId?: string;
    idempotencyKey?: string;
  } = {},
) =>
  testApp.request(`${profile.origin}${path}`, {
    method: options.method ?? "POST",
    headers: {
      Origin: profile.origin,
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.deviceId ? { "X-DotRelay-Device-Id": options.deviceId } : {}),
      ...(options.idempotencyKey
        ? { "Idempotency-Key": options.idempotencyKey }
        : {}),
    },
    body: "{}",
  });

describe("Project and Environment lifecycle routes", () => {
  test("an owner archives a Project and gets the confirmed persisted state", async () => {
    const { testApp, operations, auditEvents, projects } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/projects/${PROJECT_A}/archive`,
      {
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "d1111111-d111-4111-8111-d11111111111",
      },
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      id: PROJECT_A,
      teamId: TEAM_A,
      githubRepositoryId: "884193201",
      lifecycle: "archived",
    });
    expect(
      projects.find((project) => project.id === PROJECT_A)?.lifecycle,
    ).toBe("ARCHIVED");
    expect(operations.size).toBe(1);
    expect([...operations.values()][0]?.status).toBe("COMMITTED");
    expect(auditEvents).toEqual([
      {
        operationId: "d1111111-d111-4111-8111-d11111111111",
        kind: "PROJECT_ARCHIVED",
        actorUserId: USER_OWNER,
        actorDeviceId: DEVICE_OWNER,
        entityKind: "PROJECT",
        entityId: PROJECT_A,
        priorLifecycle: "ACTIVE",
        newLifecycle: "ARCHIVED",
      },
    ]);
  });

  test("replaying the same idempotency key returns the persisted state without re-committing", async () => {
    const { testApp, operations, auditEvents } = createTestApp();
    const options = {
      token: "owner-token",
      deviceId: DEVICE_OWNER,
      idempotencyKey: "d2222222-d222-4222-8222-d22222222222",
    };
    const first = await request(
      testApp,
      `/api/v1/projects/${PROJECT_A}/archive`,
      options,
    );
    expect(first.status).toBe(201);

    const replay = await request(
      testApp,
      `/api/v1/projects/${PROJECT_A}/archive`,
      options,
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      id: PROJECT_A,
      teamId: TEAM_A,
      githubRepositoryId: "884193201",
      lifecycle: "archived",
    });
    expect(operations.size).toBe(1);
    expect(auditEvents).toHaveLength(1);
  });

  test("a fresh key on an already-archived Project reports a state conflict", async () => {
    const { testApp } = createTestApp();
    const options = {
      token: "owner-token",
      deviceId: DEVICE_OWNER,
      idempotencyKey: "d3333333-d333-4333-8333-d33333333333",
    };
    await request(testApp, `/api/v1/projects/${PROJECT_A}/archive`, options);

    const conflict = await request(
      testApp,
      `/api/v1/projects/${PROJECT_A}/archive`,
      {
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "d3444444-d344-4344-8344-d34444444444",
      },
    );
    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as { code?: string };
    expect(body.code).toBe("state_conflict");
  });

  test("a committed key reused for a different command is an operation conflict", async () => {
    const { testApp } = createTestApp();
    const key = "dc111111-dc11-4c11-8c11-dc1111111111";
    await request(testApp, `/api/v1/projects/${PROJECT_A}/archive`, {
      token: "owner-token",
      deviceId: DEVICE_OWNER,
      idempotencyKey: key,
    });

    const conflict = await request(
      testApp,
      `/api/v1/projects/${PROJECT_A}/restore`,
      {
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: key,
      },
    );
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { code?: string }).code).toBe(
      "operation_conflict",
    );
  });

  test("a staging that never committed resumes the same operation on retry", async () => {
    const { testApp, operations, auditEvents } = createTestApp();
    const key = "dc222222-dc22-4c22-8c22-dc2222222222";
    // Pre-seed the operation a client staged before dying mid-mutation: the
    // command the route would compute for archiving PROJECT_A, still STAGED.
    const commandBytes = new TextEncoder().encode(
      JSON.stringify({ action: "project.archive", projectId: PROJECT_A }),
    );
    operations.set(key, {
      id: key,
      actorUserId: USER_OWNER,
      actorDeviceId: DEVICE_OWNER,
      kind: "ADMINISTRATION",
      commandDigest: (await sha384Digest(commandBytes)) as Uint8Array,
      status: "STAGED",
    });

    const response = await request(
      testApp,
      `/api/v1/projects/${PROJECT_A}/archive`,
      {
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: key,
      },
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      id: PROJECT_A,
      teamId: TEAM_A,
      githubRepositoryId: "884193201",
      lifecycle: "archived",
    });
    // The retry committed the same staged operation; no second operation or
    // a duplicate audit fact was created.
    expect(operations.size).toBe(1);
    expect(operations.get(key)?.status).toBe("COMMITTED");
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.operationId).toBe(key);
  });

  test("an owner restores an archived Project and gets the confirmed state", async () => {
    const { testApp, auditEvents, projects } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/projects/${PROJECT_A2}/restore`,
      {
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "d5555555-d555-4555-8555-d55555555555",
      },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      id: PROJECT_A2,
      teamId: TEAM_A,
      githubRepositoryId: "102938475",
      lifecycle: "active",
    });
    expect(
      projects.find((project) => project.id === PROJECT_A2)?.lifecycle,
    ).toBe("ACTIVE");
    expect(auditEvents[0]?.kind).toBe("PROJECT_RESTORED");
  });

  test("restoring a Project that is not archived reports a state conflict", async () => {
    const { testApp } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/projects/${PROJECT_A}/restore`,
      {
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "d6666666-d666-4666-8666-d66666666666",
      },
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as { code?: string }).code).toBe(
      "state_conflict",
    );
  });

  test("an admin may archive and restore, a Member is refused", async () => {
    const { testApp, projects } = createTestApp();
    const admin = await request(
      testApp,
      `/api/v1/projects/${PROJECT_A}/archive`,
      {
        token: "admin-token",
        deviceId: DEVICE_ADMIN,
        idempotencyKey: "d7777777-d777-4777-8777-d77777777777",
      },
    );
    expect(admin.status).toBe(201);
    expect(
      projects.find((project) => project.id === PROJECT_A)?.lifecycle,
    ).toBe("ARCHIVED");

    const member = await request(
      testApp,
      `/api/v1/projects/${PROJECT_A2}/restore`,
      {
        token: "member-token",
        deviceId: DEVICE_MEMBER,
        idempotencyKey: "d7888888-d788-4788-8788-d78888888888",
      },
    );
    expect(member.status).toBe(403);
    expect(((await member.json()) as { code?: string }).code).toBe("forbidden");
    expect(
      projects.find((project) => project.id === PROJECT_A2)?.lifecycle,
    ).toBe("ARCHIVED");
  });

  test("an owner archives an Environment and gets the confirmed persisted state", async () => {
    const { testApp, auditEvents, environments } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/environments/${ENV_A}/archive`,
      {
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "d9999999-d999-4999-8999-d99999999999",
      },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      id: ENV_A,
      projectId: PROJECT_A,
      label: "production",
      lifecycle: "archived",
      currentHeadId: "rev_0184",
    });
    expect(
      environments.find((environment) => environment.id === ENV_A)?.lifecycle,
    ).toBe("ARCHIVED");
    expect(auditEvents[0]?.kind).toBe("ENVIRONMENT_ARCHIVED");
    expect(auditEvents[0]?.entityKind).toBe("ENVIRONMENT");
  });

  test("restoring an Environment of an archived Project fails closed", async () => {
    const { testApp } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/environments/${ENV_A3}/restore`,
      {
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "da111111-da11-4a11-8a11-da1111111111",
      },
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as { code?: string }).code).toBe(
      "archived_resource",
    );
  });

  test("restoring an Environment that is not archived reports a state conflict", async () => {
    const { testApp } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/environments/${ENV_A}/restore`,
      {
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "da222222-da22-4a22-8a22-da2222222222",
      },
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as { code?: string }).code).toBe(
      "state_conflict",
    );
  });

  test("an owner restores an archived Environment once its Project is active", async () => {
    const { testApp, environments } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/environments/${ENV_A2}/restore`,
      {
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "da333333-da33-4a33-8a33-da3333333333",
      },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      id: ENV_A2,
      projectId: PROJECT_A,
      label: "staging",
      lifecycle: "active",
      currentHeadId: "rev_0102",
    });
    expect(
      environments.find((environment) => environment.id === ENV_A2)?.lifecycle,
    ).toBe("ACTIVE");
  });

  test("a Member is refused Environment lifecycle mutations", async () => {
    const { testApp, environments } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/environments/${ENV_A}/archive`,
      {
        token: "member-token",
        deviceId: DEVICE_MEMBER,
        idempotencyKey: "da444444-da44-4a44-8a44-da4444444444",
      },
    );

    expect(response.status).toBe(403);
    expect(((await response.json()) as { code?: string }).code).toBe(
      "forbidden",
    );
    expect(
      environments.find((environment) => environment.id === ENV_A)?.lifecycle,
    ).toBe("ACTIVE");
  });

  test("an unknown Project or Environment is not found", async () => {
    const { testApp } = createTestApp();
    const project = await request(
      testApp,
      `/api/v1/projects/${"e0000000-e000-4e00-8e00-e00000000000"}/archive`,
      {
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "da555555-da55-4a55-8a55-da5555555555",
      },
    );
    expect(project.status).toBe(404);
    expect(((await project.json()) as { code?: string }).code).toBe(
      "resource_not_found",
    );

    const environment = await request(
      testApp,
      `/api/v1/environments/${"e1111111-e111-4e11-8e11-e11111111111"}/restore`,
      {
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "da666666-da66-4a66-8a66-da6666666666",
      },
    );
    expect(environment.status).toBe(404);
    expect(((await environment.json()) as { code?: string }).code).toBe(
      "resource_not_found",
    );
  });

  test("lifecycle mutations require a session and an active Device", async () => {
    const { testApp } = createTestApp();
    const anonymous = await request(
      testApp,
      `/api/v1/projects/${PROJECT_A}/archive`,
      {
        deviceId: DEVICE_OWNER,
        idempotencyKey: "da777777-da77-4a77-8a77-da7777777777",
      },
    );
    expect(anonymous.status).toBe(401);
    expect(((await anonymous.json()) as { code?: string }).code).toBe(
      "authentication_required",
    );

    const noDevice = await request(
      testApp,
      `/api/v1/projects/${PROJECT_A}/archive`,
      {
        token: "owner-token",
        idempotencyKey: "da888888-da88-4a88-8a88-da8888888888",
      },
    );
    expect(noDevice.status).toBe(400);
    expect(((await noDevice.json()) as { code?: string }).code).toBe(
      "invalid_request",
    );

    const inactive = await request(
      testApp,
      `/api/v1/projects/${PROJECT_A}/archive`,
      {
        token: "owner-token",
        deviceId: DEVICE_INACTIVE,
        idempotencyKey: "da999999-da99-4a99-8a99-da9999999999",
      },
    );
    expect(inactive.status).toBe(403);
    expect(((await inactive.json()) as { code?: string }).code).toBe(
      "device_not_active",
    );
  });

  test("a Team the actor does not join cannot have its Projects touched", async () => {
    const { testApp } = createTestApp();
    const response = await request(
      testApp,
      `/api/v1/projects/${PROJECT_B}/archive`,
      {
        token: "owner-token",
        deviceId: DEVICE_OWNER,
        idempotencyKey: "eaa11111-eaa1-4eaa-8eaa-eaa111111111",
      },
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code?: string }).code).toBe(
      "forbidden",
    );
  });
});
