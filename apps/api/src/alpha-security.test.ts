import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createApi } from "./index";
import { loadServerProfileConfig } from "./profile";
import {
  actorRateLimitKey,
  createProtocolRateLimit,
} from "./protocol/rate-limit";

test("alpha gate checks stable GitHub identity for browser, CLI and old sessions", async () => {
  for (const credential of [
    { Cookie: "session=old" },
    { Authorization: "Bearer copied-token" },
  ]) {
    for (const path of [
      "/api/v1/session",
      "/api/v1/devices/bootstrap",
      "/api/auth/device/approve",
    ]) {
      let upserts = 0;
      const profile = loadServerProfileConfig({ ALPHA_GITHUB_IDS: "1001" });
      const app = createApi({
        profile,
        database: {
          authAccount: { findFirst: async () => ({ accountId: "2002" }) },
          user: {
            upsert: async () => {
              upserts++;
              return { id: "user" };
            },
          },
        } as never,
        auth: {
          api: { getSession: async () => ({ user: { id: "auth-user" } }) },
        } as never,
      });
      const response = await app.request(`${profile.origin}${path}`, {
        method: path === "/api/v1/session" ? "GET" : "POST",
        headers: { ...credential, Origin: profile.origin },
      });
      expect(response.status).toBe(403);
      expect(upserts).toBe(0);
    }
  }
});

test("alpha gate accepts listed identities and an empty list denies everyone", async () => {
  for (const ids of ["1001, 2002", ""]) {
    const profile = loadServerProfileConfig({ ALPHA_GITHUB_IDS: ids });
    const app = createApi({
      profile,
      database: {
        authAccount: { findFirst: async () => ({ accountId: "1001" }) },
        user: { upsert: async () => ({ id: "user" }) },
      } as never,
      auth: {
        api: {
          getSession: async () => ({ user: { id: "auth-user", name: "Sam" } }),
        },
      } as never,
    });
    expect((await app.request(`${profile.origin}/api/v1/session`)).status).toBe(
      ids ? 200 : 403,
    );
  }
  expect(() =>
    loadServerProfileConfig({ ALPHA_GITHUB_IDS: "mutable-login" }),
  ).toThrow();
});

test("unauthenticated callers cannot choose a limiter bucket with arbitrary headers", async () => {
  const app = new Hono();
  let reached = false;
  app.use(
    "*",
    createProtocolRateLimit(
      false,
      async () => new Response(null, { status: 401 }),
    ),
  );
  app.put("*", (context) => {
    reached = true;
    return context.text("ok");
  });
  const response = await app.request(
    "/api/v1/operations/random/staging/random",
    {
      method: "PUT",
      headers: { Authorization: "random", "X-DotRelay-Device-Id": "random" },
    },
  );
  expect(response.status).toBe(401);
  expect(reached).toBe(false);
  expect(await actorRateLimitKey("user-a")).toBe(
    await actorRateLimitKey("user-a"),
  );
  expect(await actorRateLimitKey("user-a")).not.toBe(
    await actorRateLimitKey("user-b"),
  );
});
