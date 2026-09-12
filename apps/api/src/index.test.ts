import { describe, expect, test } from "bun:test";
import { createProblem } from "@dotrelay/contracts";
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
    expect(response.headers.get("x-correlation-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("keeps domain responses successful when the observability sink throws", async () => {
    const profile = loadServerProfileConfig({});
    const auth = createInMemoryAuth(profile);
    let domainCommitCount = 0;
    const testApp = createApi({
      database: {} as never,
      profile,
      auth,
      observability: {
        diagnostics: { emit: () => undefined },
        expireSecurityRequestLogs: async () => 0,
        recordRequest: () => {
          throw new Error("observability sink unavailable");
        },
      },
    });
    testApp.post("/test-domain-commit", (context) =>
      context.json({ committed: ++domainCommitCount }, 201),
    );

    const response = await testApp.request(`${profile.origin}/health`);
    const domainResponse = await testApp.request(
      `${profile.origin}/test-domain-commit`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(domainResponse.status).toBe(201);
    expect(await domainResponse.json()).toEqual({ committed: 1 });
    expect(domainCommitCount).toBe(1);
  });

  test("returns a generic problem for uncaught route failures", async () => {
    const profile = loadServerProfileConfig({});
    const auth = createInMemoryAuth(profile);
    const testApp = createApi({ database: {} as never, profile, auth });
    testApp.get("/test-unhandled-error", () => {
      throw new Error("secret request body and stack");
    });

    const response = await testApp.request(
      `${profile.origin}/test-unhandled-error`,
    );
    const problem = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(problem).toMatchObject({
      code: "service_unavailable",
      detail: "Service unavailable",
    });
    expect(problem.correlationId).toBe(
      response.headers.get("x-correlation-id"),
    );
    expect(JSON.stringify(problem)).not.toContain("secret request body");
  });

  test("attaches only the structured problem code to request diagnostics", async () => {
    const profile = loadServerProfileConfig({});
    const records: Array<Record<string, unknown>> = [];
    const testApp = createApi({
      database: {} as never,
      profile,
      auth: createInMemoryAuth(profile),
      observability: {
        diagnostics: { emit: () => undefined },
        expireSecurityRequestLogs: async () => 0,
        recordRequest: (input) => records.push(input),
      },
    });
    testApp.get("/test-problem", (context) => {
      const problem = createProblem("rate_limited", {
        retryAfterSeconds: 60,
      });
      return context.json(problem, 429, {
        "Content-Type": "application/problem+json",
      });
    });

    const response = await testApp.request(`${profile.origin}/test-problem`);

    expect(response.status).toBe(429);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      status: 429,
      problemCode: "rate_limited",
      retryAfterSeconds: 60,
    });
    expect(records[0]).not.toHaveProperty("responseBody");
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
    expect(response.headers.get("access-control-expose-headers")).toContain(
      "X-Correlation-ID",
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

  test("exposes Correlation IDs on protocol CORS responses", async () => {
    const profile = loadServerProfileConfig({});
    const auth = createInMemoryAuth(profile);
    const testApp = createApi({ database: {} as never, profile, auth });

    const response = await testApp.request(
      `${profile.origin}/api/v1/devices/bootstrap`,
      {
        method: "OPTIONS",
        headers: {
          Origin: profile.origin,
          "Access-Control-Request-Method": "POST",
        },
      },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-expose-headers")).toContain(
      "X-Correlation-ID",
    );
    expect(response.headers.get("x-correlation-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("allows the web origin to preflight Environment sync", async () => {
    const profile = loadServerProfileConfig({
      WEB_ORIGIN: "http://localhost:3000",
    });
    const auth = createInMemoryAuth(profile);
    const testApp = createApi({ database: {} as never, profile, auth });
    const environmentId = "00000000-0000-4000-8000-000000000014";

    const response = await testApp.request(
      `${profile.origin}/api/v1/environments/${environmentId}/sync`,
      {
        method: "OPTIONS",
        headers: {
          Origin: profile.webOrigin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers":
            "content-type,x-dotrelay-device-id,accept",
        },
      },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      profile.webOrigin,
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
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

  test("sanitizes Better Auth error responses", async () => {
    const profile = loadServerProfileConfig({});
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
        body: JSON.stringify({ provider: "not-configured" }),
      },
    );
    const problem = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(problem).toMatchObject({
      code: "service_unavailable",
      detail: "Service unavailable",
    });
    expect(JSON.stringify(problem)).not.toContain("PROVIDER_NOT_FOUND");
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

  test("disables Better Auth logging at the privacy boundary", () => {
    const auth = createInMemoryAuth(loadServerProfileConfig());

    expect(auth.options.logger).toEqual({ disabled: true });
  });

  test("redirects device verification to the web origin without reflecting markup", async () => {
    const profile = loadServerProfileConfig({});
    const testApp = createApi({
      database: {} as never,
      profile,
      auth: createInMemoryAuth(profile),
    });
    const response = await testApp.request(
      `${profile.origin}/device?user_code=%3Cscript%3E`,
      { redirect: "manual" },
    );
    const location = response.headers.get("location") ?? "";

    expect(response.status).toBe(302);
    expect(location.startsWith(`${profile.webOrigin}/device?`)).toBe(true);
    expect(location).toContain("user_code=%3Cscript%3E");
    expect(location).not.toContain("<script>");
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
            label: "default",
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
          label: "default",
          lifecycle: "active",
          currentHeadId: null,
        },
      ],
    });
  });

  test("lists Team names and rejects an empty Team create body", async () => {
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
      team: {
        findMany: async () => [
          { id: "00000000-0000-4000-8000-000000000001", name: "Personal" },
        ],
      },
    } as never;
    const testApp = createApi({ database, profile, auth });
    const listed = await testApp.request(`${profile.origin}/api/v1/teams`, {
      headers: {
        Origin: profile.origin,
        Authorization: "Bearer session-token",
        "X-DotRelay-Device-Id": "device-id",
      },
    });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      teams: [{ id: "00000000-0000-4000-8000-000000000001", name: "Personal" }],
    });

    const created = await testApp.request(`${profile.origin}/api/v1/teams`, {
      method: "POST",
      headers: {
        Origin: profile.origin,
        Authorization: "Bearer session-token",
        "Content-Type": "application/json",
        "Idempotency-Key": "00000000-0000-4000-8000-000000000099",
        "X-DotRelay-Device-Id": "device-id",
      },
      body: JSON.stringify({ name: "   " }),
    });
    expect(created.status).toBe(400);
  });
});

describe("workspace boundary Device binding", () => {
  const userId = "22222222-2222-4222-8222-222222222222";
  const teamId = "44444444-4444-4444-8444-444444444444";
  const projectId = "55555555-5555-4555-8555-555555555555";
  const environmentId = "66666666-6666-4666-8666-666666666666";
  // The first-created Device holds the epoch grant; the later Device does not.
  const olderDeviceId = "33333333-3333-4333-8333-333333333333";
  const newerDeviceId = "77777777-7777-4777-8777-777777777777";

  const matchGrant = (
    where: Record<string, unknown>,
    grant: {
      readonly projectId: string;
      readonly recipientDeviceId: string;
      readonly projectEpoch: bigint;
      readonly grantKind: string;
    },
  ) => {
    if (
      grant.projectId !== where.projectId ||
      grant.projectEpoch !== where.projectEpoch ||
      grant.grantKind !== where.grantKind
    )
      return false;
    const recipient = where.recipientDeviceId;
    if (recipient === undefined) return true;
    if (
      typeof recipient === "object" &&
      recipient !== null &&
      "in" in recipient
    )
      return (recipient.in as readonly string[]).includes(
        grant.recipientDeviceId,
      );
    return grant.recipientDeviceId === recipient;
  };

  const createTestApp = () => {
    const olderGrantBytes = new TextEncoder().encode(
      "older-device-epoch-grant",
    );
    const grants = [
      {
        projectId,
        recipientDeviceId: olderDeviceId,
        projectEpoch: 1n,
        grantKind: "CURRENT_PROJECT_EPOCH",
        protocolObject: {
          canonicalBytes: olderGrantBytes,
          acceptedAt: new Date("2026-01-02T00:00:00Z"),
        },
      },
    ];
    const devices = [
      {
        id: olderDeviceId,
        userId,
        lifecycle: "ACTIVE",
        x25519PublicKey: new Uint8Array(32).fill(0x55),
        ed25519PublicKey: new Uint8Array(32).fill(0x22),
      },
      {
        id: newerDeviceId,
        userId,
        lifecycle: "ACTIVE",
        x25519PublicKey: new Uint8Array(32).fill(0x66),
        ed25519PublicKey: new Uint8Array(32).fill(0x77),
      },
    ];
    const database = {
      authAccount: {
        findFirst: async () => ({ accountId: "github-user" }),
      },
      user: { upsert: async () => ({ id: userId }) },
      device: {
        findMany: async ({
          where,
        }: {
          where: { userId?: string; id?: string };
        }) =>
          devices.filter(
            (candidate) =>
              candidate.userId === (where.userId ?? userId) &&
              (where.id ? candidate.id === where.id : true),
          ),
      },
      membership: {
        findFirst: async () => ({ teamId }),
        findMany: async () => [],
      },
      project: {
        findFirst: async () => ({
          id: projectId,
          teamId,
          currentEpoch: 1n,
        }),
      },
      environment: {
        findFirst: async () => ({
          id: environmentId,
          label: "default",
          currentHeadId: null,
          currentHead: null,
        }),
      },
      grantObject: {
        count: async (args: { where: Record<string, unknown> }) =>
          grants.filter((grant) => matchGrant(args.where, grant)).length,
        findFirst: async (args: { where: Record<string, unknown> }) =>
          grants.find((grant) => matchGrant(args.where, grant)) ?? null,
        findMany: async (args: { where: Record<string, unknown> }) =>
          grants.filter((grant) => matchGrant(args.where, grant)),
      },
    };
    const profile = loadServerProfileConfig({});
    const auth = {
      api: {
        getSession: async () => ({ user: { id: "auth-user", name: "Ari" } }),
      },
    } as never;
    return createApi({ database: database as never, profile, auth });
  };

  const boundaryRequest = async (
    testApp: ReturnType<typeof createTestApp>,
    profile: ReturnType<typeof loadServerProfileConfig>,
    deviceId?: string,
  ) => {
    const headers: Record<string, string> = {
      Origin: profile.origin,
      Authorization: "Bearer session-token",
    };
    if (deviceId) headers["X-DotRelay-Device-Id"] = deviceId;
    return testApp.request(`${profile.origin}/api/v1/workspace/boundary`, {
      headers,
    });
  };

  test("resolves the presented Device's grants, not the first-created Device's", async () => {
    const profile = loadServerProfileConfig({});
    const testApp = createTestApp();
    const response = await boundaryRequest(testApp, profile, newerDeviceId);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.device).toEqual({
      active: true,
      label: "Active Device",
      id: newerDeviceId,
      encryptionPublicKey: "66".repeat(32),
      signingPublicKey: "77".repeat(32),
    });
    expect(body.grantsReady).toBe(false);
    expect(body).not.toHaveProperty("epochGrant");
    expect(body.activeDeviceCount).toBe(2);
    expect(body.peerDevices).toEqual([
      {
        id: olderDeviceId,
        encryptionPublicKey: "55".repeat(32),
        signingPublicKey: "22".repeat(32),
        hasEpochGrant: true,
      },
    ]);
  });

  test("resolves the first-created Device's own epoch grant when it is presented", async () => {
    const profile = loadServerProfileConfig({});
    const testApp = createTestApp();
    const response = await boundaryRequest(testApp, profile, olderDeviceId);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.device).toMatchObject({
      active: true,
      id: olderDeviceId,
    });
    expect(body.grantsReady).toBe(true);
    expect(body.epochGrant).toBe(
      Buffer.from("older-device-epoch-grant").toString("base64"),
    );
  });

  test("a missing Device header reports no Device instead of falling back", async () => {
    const profile = loadServerProfileConfig({});
    const testApp = createTestApp();
    const response = await boundaryRequest(testApp, profile);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.device).toEqual({
      active: false,
      label: "No active Device",
    });
    expect(body.grantsReady).toBe(false);
    expect(body).not.toHaveProperty("epochGrant");
    expect(body.activeDeviceCount).toBe(2);
    expect(body.peerDevices).toEqual([
      {
        id: olderDeviceId,
        encryptionPublicKey: "55".repeat(32),
        signingPublicKey: "22".repeat(32),
        hasEpochGrant: true,
      },
      {
        id: newerDeviceId,
        encryptionPublicKey: "66".repeat(32),
        signingPublicKey: "77".repeat(32),
        hasEpochGrant: false,
      },
    ]);
  });

  test("an unknown or malformed Device header reports no Device", async () => {
    const profile = loadServerProfileConfig({});
    const testApp = createTestApp();
    for (const header of [
      "00000000-0000-4000-8000-0000000000ff",
      "not-a-device-uuid",
    ]) {
      const response = await boundaryRequest(testApp, profile, header);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.device).toEqual({
        active: false,
        label: "No active Device",
      });
      expect(body.grantsReady).toBe(false);
      expect(body).not.toHaveProperty("epochGrant");
      expect(body.activeDeviceCount).toBe(2);
    }
  });
});
