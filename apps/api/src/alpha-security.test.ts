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
      "/api/auth/get-session",
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
              return { id: "user", githubSubject: "2002" };
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
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({
        code: "alpha_admission_required",
      });
      // The answer names neither the allow list nor the caller's account.
      expect(body).not.toContain("1001");
      expect(body).not.toContain("2002");
      expect(body).not.toContain("auth-user");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(upserts).toBe(0);
    }
  }
});

test("a session outside the alpha list can still sign out and read capabilities", async () => {
  const profile = loadServerProfileConfig({ ALPHA_GITHUB_IDS: "1001" });
  let signOuts = 0;
  const app = createApi({
    profile,
    database: {
      authAccount: { findFirst: async () => ({ accountId: "2002" }) },
    } as never,
    auth: {
      api: { getSession: async () => ({ user: { id: "auth-user" } }) },
      handler: async () => {
        signOuts++;
        return Response.json({ success: true });
      },
    } as never,
  });
  const signOut = await app.request(`${profile.origin}/api/auth/sign-out`, {
    method: "POST",
    headers: { Cookie: "session=old", Origin: profile.origin },
  });
  expect(signOut.status).toBe(200);
  expect(signOuts).toBe(1);
  const capabilities = await app.request(
    `${profile.origin}/api/v1/capabilities`,
    { headers: { Cookie: "session=old" } },
  );
  expect(capabilities.status).not.toBe(403);
});

test("alpha gate accepts listed identities and an empty list denies everyone", async () => {
  for (const ids of ["1001, 2002", ""]) {
    const profile = loadServerProfileConfig({ ALPHA_GITHUB_IDS: ids });
    const app = createApi({
      profile,
      database: {
        authAccount: { findFirst: async () => ({ accountId: "1001" }) },
        user: {
          upsert: async (input: { create: { githubSubject: string } }) => ({
            id: "user",
            githubSubject: input.create.githubSubject,
          }),
        },
      } as never,
      auth: {
        api: {
          getSession: async () => ({ user: { id: "auth-user", name: "Sam" } }),
        },
      } as never,
    });
    const response = await app.request(`${profile.origin}/api/v1/session`);
    expect(response.status).toBe(ids ? 200 : 403);
    if (!ids)
      expect(((await response.json()) as { code: string }).code).toBe(
        "alpha_admission_required",
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

test("required alpha admission fails closed on missing configuration", () => {
  expect(() =>
    loadServerProfileConfig({ ALPHA_ADMISSION_REQUIRED: "true" }),
  ).toThrow("ALPHA_GITHUB_IDS");
  expect(
    loadServerProfileConfig({
      ALPHA_ADMISSION_REQUIRED: "true",
      ALPHA_GITHUB_IDS: "",
    }).allowedGitHubIds,
  ).toEqual([]);
  expect(
    loadServerProfileConfig({ ALPHA_ADMISSION_REQUIRED: "false" })
      .allowedGitHubIds,
  ).toBeUndefined();
});
