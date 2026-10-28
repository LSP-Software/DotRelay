import { expect, test } from "bun:test";
import { createApi } from "./index";
import { loadServerProfileConfig } from "./profile";

const fixture = () => {
  const profile = loadServerProfileConfig({});
  const actor = crypto.randomUUID();
  const actorDevice = crypto.randomUUID();
  const target = {
    id: crypto.randomUUID(),
    userId: actor,
    lifecycle: "ACTIVE",
  };
  const sessions = new Set(["current-token", "copied-token"]);
  const operations = new Map<string, Record<string, unknown>>();
  const deletedUsers: string[] = [];
  const transaction = {
    $executeRaw: async () => 0,
    user: {
      upsert: async () => ({ id: actor }),
      findUniqueOrThrow: async () => ({ authSubject: "auth-user" }),
    },
    authAccount: { findFirst: async () => ({ accountId: "1001" }) },
    authSession: {
      deleteMany: async ({ where }: { where: { userId: string } }) => {
        deletedUsers.push(where.userId);
        sessions.clear();
        return { count: 2 };
      },
    },
    authDeviceCode: {
      deleteMany: async ({ where }: { where: { userId: string } }) => {
        expect(where.userId).toBe("auth-user");
        return { count: 1 };
      },
    },
    device: {
      findFirst: async () => ({
        id: actorDevice,
        userId: actor,
        lifecycle: "ACTIVE",
      }),
      findUnique: async () => ({ ...target }),
      update: async () => {
        target.lifecycle = "REVOKED";
        return { ...target };
      },
    },
    operation: {
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        for (const entry of data)
          operations.set(String(entry.id), { ...entry, status: "STAGED" });
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        operations.get(where.id) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => Object.assign(operations.get(where.id) ?? {}, data),
    },
    auditEvent: { create: async () => ({}) },
  };
  const database = {
    ...transaction,
    $transaction: async (
      callback: (tx: typeof transaction) => Promise<unknown>,
    ) => callback(transaction),
  };
  const app = createApi({
    profile,
    database: database as never,
    auth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) =>
          sessions.has(
            headers.get("Authorization")?.replace("Bearer ", "") ?? "",
          )
            ? { user: { id: "auth-user" } }
            : null,
      },
    } as never,
  });
  const revoke = () =>
    app.request(`${profile.origin}/api/v1/devices/${target.id}/revoke`, {
      method: "POST",
      headers: {
        Authorization: "Bearer current-token",
        "X-DotRelay-Device-Id": actorDevice,
        "Idempotency-Key": crypto.randomUUID(),
      },
    });
  return { profile, app, target, sessions, operations, deletedUsers, revoke };
};

test("revocation invalidates copied sessions before they can bootstrap replacements", async () => {
  const setup = fixture();
  expect((await setup.revoke()).status).toBe(200);
  expect(setup.target.lifecycle).toBe("REVOKED");
  expect(setup.deletedUsers).toEqual(["auth-user"]);
  expect(setup.sessions.size).toBe(0);
  const response = await setup.app.request(
    `${setup.profile.origin}/api/v1/devices/bootstrap`,
    {
      method: "POST",
      headers: { Authorization: "Bearer copied-token" },
    },
  );
  expect(response.status).toBe(401);
});

test("a User cannot revoke another User's Device or sessions", async () => {
  const setup = fixture();
  setup.target.userId = crypto.randomUUID();
  expect((await setup.revoke()).status).toBe(404);
  expect(setup.target.lifecycle).toBe("ACTIVE");
  expect(setup.sessions.size).toBe(2);
  expect(setup.deletedUsers).toHaveLength(0);
  expect(setup.operations.size).toBe(0);
});
