import { describe, expect, test } from "bun:test";
import { createInMemoryAuth } from "./auth";
import { app, createApi } from "./index";
import { loadServerProfileConfig } from "./profile";

const deviceTokenRequest = (
  testApp: ReturnType<typeof createApi>,
  profile: ReturnType<typeof loadServerProfileConfig>,
  deviceCode: string,
) =>
  testApp.request(`${profile.origin}/api/auth/device/token`, {
    method: "POST",
    headers: {
      Origin: profile.origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: "dotrelay-cli",
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });

describe("API foundation", () => {
  test("exposes a health endpoint", async () => {
    const response = await app.request("http://localhost/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("publishes a profile-bound capabilities document with an ETag", async () => {
    const response = await app.request("http://localhost/api/v1/capabilities");
    const capabilities = await response.json();

    expect(response.status).toBe(200);
    expect(capabilities).toMatchObject({
      serverProfileId: "00000000-0000-4000-8000-000000000001",
      origin: "http://localhost:3001",
      apiVersion: "v1",
      suite: { value: 3 },
    });
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=60, must-revalidate",
    );

    const cached = await app.request("http://localhost/api/v1/capabilities", {
      headers: { "If-None-Match": response.headers.get("etag") ?? "" },
    });
    expect(cached.status).toBe(304);
  });

  test("rejects an untrusted origin and mixed cookie/bearer credentials", async () => {
    const originResponse = await app.request(
      "http://localhost/api/v1/capabilities",
      {
        headers: { Origin: "https://attacker.example" },
      },
    );
    expect(originResponse.status).toBe(403);

    const mixedResponse = await app.request("http://localhost/api/v1/session", {
      headers: {
        Authorization: "Bearer token",
        Cookie: "better-auth.session_token=session",
      },
    });
    expect(mixedResponse.status).toBe(401);
    expect(await mixedResponse.json()).toMatchObject({
      code: "authentication_required",
    });
  });

  test("requires an Origin on cookie-authenticated state changes", async () => {
    const response = await app.request("http://localhost/api/auth/sign-out", {
      method: "POST",
      headers: { Cookie: "better-auth.session_token=session" },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden" });
  });

  test("keeps auth CORS exact and exposes the device flow", async () => {
    const profile = loadServerProfileConfig({});
    const auth = createInMemoryAuth(profile);
    const testApp = createApi({
      database: {} as never,
      profile,
      auth,
    });
    const response = await testApp.request(
      "http://localhost:3001/api/auth/device/code",
      {
        method: "POST",
        headers: {
          Origin: profile.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ client_id: "dotrelay-cli" }),
      },
    );
    const device = (await response.json()) as {
      device_code: string;
      verification_uri: string;
      interval: number;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      profile.origin,
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
    expect(device).toMatchObject({
      verification_uri: `${profile.origin}/device`,
      interval: expect.any(Number),
    });

    const tokenResponse = await testApp.request(
      "http://localhost:3001/api/auth/device/token",
      {
        method: "POST",
        headers: {
          Origin: profile.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: "dotrelay-cli",
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      },
    );
    expect(tokenResponse.status).toBe(400);
    expect(await tokenResponse.json()).toMatchObject({
      error: "authorization_pending",
    });
  });

  test("enforces device polling intervals, expiry, and endpoint rate limits", async () => {
    const profile = loadServerProfileConfig({});
    const auth = createInMemoryAuth(profile);
    const testApp = createApi({ database: {} as never, profile, auth });
    const codeResponse = await testApp.request(
      `${profile.origin}/api/auth/device/code`,
      {
        method: "POST",
        headers: {
          Origin: profile.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ client_id: "dotrelay-cli" }),
      },
    );
    const code = (await codeResponse.json()) as {
      device_code: string;
      expires_in: number;
      interval: number;
    };
    expect(code).toMatchObject({ expires_in: 1800, interval: 5 });

    const pending = await deviceTokenRequest(
      testApp,
      profile,
      code.device_code,
    );
    expect(await pending.json()).toMatchObject({
      error: "authorization_pending",
    });
    const tooFast = await deviceTokenRequest(
      testApp,
      profile,
      code.device_code,
    );
    expect(await tooFast.json()).toMatchObject({ error: "slow_down" });

    const context = await auth.$context;
    const record = await context.adapter.findOne<{
      id: string;
    }>({
      model: "deviceCode",
      where: [{ field: "deviceCode", value: code.device_code }],
    });
    expect(record).not.toBeNull();
    await context.adapter.update({
      model: "deviceCode",
      where: [{ field: "id", value: record?.id ?? "" }],
      update: { expiresAt: new Date(0), lastPolledAt: null },
    });
    const expired = await deviceTokenRequest(
      testApp,
      profile,
      code.device_code,
    );
    expect(await expired.json()).toMatchObject({ error: "expired_token" });

    const limitedAuth = createInMemoryAuth(profile);
    const limitedApp = createApi({
      database: {} as never,
      profile,
      auth: limitedAuth,
    });
    const responses = [];
    for (let request = 0; request < 11; request += 1) {
      responses.push(
        await limitedApp.request(`${profile.origin}/api/auth/device/code`, {
          method: "POST",
          headers: {
            Origin: profile.origin,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ client_id: "dotrelay-cli" }),
        }),
      );
    }
    const firstLimited = responses.findIndex(
      (response) => response.status === 429,
    );
    expect(firstLimited).toBeGreaterThan(0);
    expect(
      responses
        .slice(firstLimited)
        .every((response) => response.status === 429),
    ).toBe(true);
    expect(responses[firstLimited]?.headers.get("x-retry-after")).toBe("60");
    expect(
      responses[firstLimited]?.headers.get("access-control-expose-headers"),
    ).toContain("X-Retry-After");
  });

  test("uses the exact GitHub callback and secure browser state cookies", async () => {
    const profile = loadServerProfileConfig({
      NODE_ENV: "production",
      SERVER_PROFILE_ID: "00000000-0000-4000-8000-000000000042",
      SERVER_PROFILE_ORIGIN: "https://relay.example",
      BETTER_AUTH_SECRET: "x".repeat(32),
      GITHUB_CLIENT_ID: "github-client",
      GITHUB_CLIENT_SECRET: "github-secret",
    });
    const auth = createInMemoryAuth(profile);
    const testApp = createApi({ database: {} as never, profile, auth });
    const response = await testApp.request(
      `${profile.origin}/api/auth/sign-in/social`,
      {
        method: "POST",
        headers: {
          Origin: profile.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "github",
          callbackURL: "/device?user_code=ABCDEFGH",
        }),
      },
    );
    const authorization = new URL(response.headers.get("location") ?? "");

    expect(response.status).toBe(200);
    expect(authorization.origin).toBe("https://github.com");
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      `${profile.origin}/api/auth/callback/github`,
    );
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(response.headers.get("set-cookie")).toContain("Secure");

    const rejectedCallback = await testApp.request(
      `${profile.origin}/api/auth/callback/github?code=fake&state=fake`,
    );
    expect(rejectedCallback.status).toBe(302);
    expect(rejectedCallback.headers.get("location")).toBe(
      `${profile.origin}/api/auth/error?error=state_mismatch`,
    );
    expect(await rejectedCallback.text()).not.toContain("state.mjs");
  });

  test("applies logout, remote revocation, and expiry on the next bearer request", async () => {
    const profile = loadServerProfileConfig({});
    const auth = createInMemoryAuth(profile);
    const testApp = createApi({ database: {} as never, profile, auth });
    const context = await auth.$context;
    const user = await context.internalAdapter.createUser(
      {
        email: "auth-test@example.com",
        emailVerified: true,
        name: "Auth Test",
      },
      {
        method: "oauth",
        oauth: { providerId: "github" },
      },
    );
    const createSession = async () => {
      const session = await context.internalAdapter.createSession(
        user.id,
        false,
      );
      if (!session) throw new Error("test session was not created");
      return session;
    };
    const sessionHeaders = (token: string) =>
      new Headers({ Authorization: `Bearer ${token}` });

    const loggedOut = await createSession();
    expect(
      await auth.api.getSession({ headers: sessionHeaders(loggedOut.token) }),
    ).not.toBeNull();
    const logoutResponse = await testApp.request(
      `${profile.origin}/api/auth/sign-out`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${loggedOut.token}` },
      },
    );
    expect(logoutResponse.status).toBe(200);
    expect(
      await auth.api.getSession({ headers: sessionHeaders(loggedOut.token) }),
    ).toBeNull();

    const administrator = await createSession();
    const remotelyRevoked = await createSession();
    await auth.api.revokeSession({
      headers: sessionHeaders(administrator.token),
      body: { token: remotelyRevoked.token },
    });
    expect(
      await auth.api.getSession({
        headers: sessionHeaders(remotelyRevoked.token),
      }),
    ).toBeNull();

    const expired = await createSession();
    await context.internalAdapter.updateSession(expired.token, {
      expiresAt: new Date(0),
    });
    expect(
      await auth.api.getSession({ headers: sessionHeaders(expired.token) }),
    ).toBeNull();
    expect(auth.options.session?.cookieCache).toEqual({ enabled: false });
  });

  test("serves the device verification page without reflecting markup", async () => {
    const response = await app.request(
      "http://localhost:3001/device?user_code=%3Cscript%3E",
    );
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(page).toContain("&lt;script&gt;");
    expect(page).not.toContain("<strong><script>");
  });

  test("exposes only opaque Environment metadata to an active Device", async () => {
    const profile = loadServerProfileConfig({});
    const auth = {
      api: {
        getSession: async () => ({
          user: { id: "auth-user", name: "Ari" },
        }),
      },
    } as never;
    const database = {
      authAccount: { findFirst: async () => ({ accountId: "github-user" }) },
      user: { upsert: async () => ({ id: "user-id" }) },
      device: { findFirst: async () => ({ id: "device-id" }) },
      project: { findUnique: async () => ({ teamId: "team-id" }) },
      membership: { findFirst: async () => ({ id: "membership-id" }) },
      environment: {
        findMany: async () => [
          {
            id: "00000000-0000-4000-8000-000000000003",
            projectId: "00000000-0000-4000-8000-000000000002",
            lifecycle: "ACTIVE",
            currentHeadId: null,
          },
        ],
      },
    } as never;
    const testApp = createApi({ database, profile, auth });
    const response = await testApp.request(
      `${profile.origin}/api/v1/projects/00000000-0000-4000-8000-000000000002/environments`,
      {
        headers: {
          Origin: profile.origin,
          Authorization: "Bearer session-token",
          "X-DotRelay-Device-Id": "device-id",
        },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      environments: [
        {
          id: "00000000-0000-4000-8000-000000000003",
          projectId: "00000000-0000-4000-8000-000000000002",
          lifecycle: "active",
          currentHeadId: null,
        },
      ],
    });
  });
});
