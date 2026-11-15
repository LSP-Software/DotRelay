import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createSessionLifetimeGate, SESSION_MAX_AGE_MS } from "./session";

const gatedApp = (createdAt: Date) => {
  const deleted: string[] = [];
  let sessionPresent = true;
  const auth = {
    api: {
      getSession: async () =>
        sessionPresent
          ? {
              user: { id: "auth-user" },
              session: { id: "session-id", createdAt },
            }
          : null,
    },
  } as never;
  const database = {
    authSession: {
      deleteMany: async ({ where }: { where: { id: string } }) => {
        deleted.push(where.id);
        sessionPresent = false;
        return { count: 1 };
      },
    },
  } as never;
  const now = new Date("2026-11-13T00:00:00.000Z");
  const app = new Hono();
  app.use(
    "*",
    createSessionLifetimeGate(database, auth, () => now),
  );
  app.get("*", (context) => context.text("ok"));
  return { app, deleted, now };
};

test("a session older than the absolute lifetime is deleted before any route reads it", async () => {
  const now = new Date("2026-11-13T00:00:00.000Z");
  const aged = gatedApp(new Date(now.getTime() - SESSION_MAX_AGE_MS - 1));
  const response = await aged.app.request("/api/v1/teams", {
    headers: { Authorization: "Bearer token" },
  });
  expect(response.status).toBe(200);
  expect(aged.deleted).toEqual(["session-id"]);
});

test("a session within the lifetime, or a request without credentials, is untouched", async () => {
  const now = new Date("2026-11-13T00:00:00.000Z");
  const fresh = gatedApp(new Date(now.getTime() - SESSION_MAX_AGE_MS + 1_000));
  await fresh.app.request("/api/v1/teams", {
    headers: { Authorization: "Bearer token" },
  });
  expect(fresh.deleted).toEqual([]);
  const aged = gatedApp(new Date(0));
  await aged.app.request("/api/v1/teams");
  expect(aged.deleted).toEqual([]);
  expect(SESSION_MAX_AGE_MS).toBe(90 * 24 * 60 * 60 * 1_000);
});

// A-7: the request log budgets anonymous requests, so it needs to know which
// requests a signed-in session made.
test("reports whether a signed-in session made the request", async () => {
  const { requestWasAuthenticated } = await import("./session");
  const seen: boolean[] = [];
  const auth = {
    api: {
      getSession: async ({ headers }: { headers: Headers }) =>
        headers.get("Authorization") === "Bearer valid"
          ? {
              user: { id: "auth-user" },
              session: { id: "session-id", createdAt: new Date() },
            }
          : null,
    },
  } as never;
  const app = new Hono();
  app.use("*", async (context, next) => {
    await next();
    seen.push(await requestWasAuthenticated(context));
  });
  app.use("*", createSessionLifetimeGate({} as never, auth));
  app.get("*", (context) => context.text("ok"));
  await app.request("/api/auth/get-session");
  await app.request("/api/auth/get-session", {
    headers: { Authorization: "Bearer forged" },
  });
  await app.request("/api/auth/get-session", {
    headers: { Authorization: "Bearer valid" },
  });
  expect(seen).toEqual([false, false, true]);
});
