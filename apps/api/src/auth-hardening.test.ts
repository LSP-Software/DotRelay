import { describe, expect, test } from "bun:test";
import { createInMemoryAuth, signBearerToken } from "./auth";
import { createApi } from "./index";
import { loadServerProfileConfig } from "./profile";

const testAuthSecret = "auth-hardening-secret-0123456789-abcdefghijklmnop";

// The sign-in route shares one rate-limit bucket per client address across
// every test in the process, so this test signs in from its own address.
const githubProfile = () =>
  loadServerProfileConfig({
    BETTER_AUTH_SECRET: testAuthSecret,
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
    SERVER_PROFILE_TRUST_PROXY: "true",
  });
const clientAddress = `198.51.100.${1 + Math.floor(Math.random() * 250)}`;

// A-3: a User keeps the one GitHub account that created them; a sign-in with
// another GitHub account is never linked to that User.
describe("GitHub account linking", () => {
  test("a different GitHub account with the same verified email is refused, not linked", async () => {
    const profile = githubProfile();
    const auth = createInMemoryAuth(profile);
    const app = createApi({ database: {} as never, profile, auth });
    const context = await auth.$context;
    const existing = await context.internalAdapter.createUser(
      { email: "owner@example.com", emailVerified: true, name: "Owner" },
      { method: "oauth", oauth: { providerId: "github" } },
    );
    await context.internalAdapter.linkAccount({
      providerId: "github",
      accountId: "4242",
      userId: existing.id,
    });

    const started = await app.request(
      `${profile.origin}/api/auth/sign-in/social`,
      {
        method: "POST",
        headers: {
          Origin: profile.webOrigin,
          "Content-Type": "application/json",
          "X-Forwarded-For": clientAddress,
        },
        body: JSON.stringify({
          provider: "github",
          callbackURL: `${profile.webOrigin}/workspace`,
        }),
      },
    );
    expect(started.status).toBe(200);
    const authorization = new URL(started.headers.get("location") ?? "");
    const stateCookie = started.headers
      .getSetCookie()
      .find((cookie) => cookie.includes("oauth_state="));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.startsWith("https://github.com/login/oauth/access_token"))
        return Response.json({
          access_token: "gho_other",
          token_type: "bearer",
        });
      if (url === "https://api.github.com/user")
        return Response.json({
          id: 9999,
          login: "someone-else",
          name: "Someone Else",
          avatar_url: "https://example.com/b.png",
        });
      if (url === "https://api.github.com/user/emails")
        return Response.json([
          { email: "owner@example.com", primary: true, verified: true },
        ]);
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const completed = await app.request(
        `${profile.origin}/api/auth/callback/github?code=other&state=${authorization.searchParams.get("state")}`,
        {
          headers: {
            cookie: stateCookie?.split(";", 1)[0] ?? "",
            "X-Forwarded-For": clientAddress,
          },
        },
      );
      expect(
        completed.headers
          .getSetCookie()
          .some(
            (cookie) =>
              cookie.includes("session_token=") && !/max-age=0/i.test(cookie),
          ),
      ).toBe(false);
      const accounts = await context.internalAdapter.findAccounts(existing.id);
      expect(accounts.map((account) => account.accountId)).toEqual(["4242"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("link and unlink routes are not reachable", async () => {
    const profile = loadServerProfileConfig({});
    const app = createApi({
      database: {} as never,
      profile,
      auth: createInMemoryAuth(profile),
    });
    for (const path of ["/api/auth/link-social", "/api/auth/unlink-account"]) {
      const response = await app.request(`${profile.origin}${path}`, {
        method: "POST",
        headers: {
          Origin: profile.webOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider: "github" }),
      });
      expect(response.status).toBe(403);
    }
  });
});

// A-4: session tokens are not returned to the browser, and only
// service-signed bearer tokens are accepted.
describe("session tokens", () => {
  const setup = async () => {
    const profile = loadServerProfileConfig({
      BETTER_AUTH_SECRET: testAuthSecret,
    });
    const auth = createInMemoryAuth(profile);
    const app = createApi({ database: {} as never, profile, auth });
    const context = await auth.$context;
    const user = await context.internalAdapter.createUser(
      {
        email: `token-${crypto.randomUUID()}@example.com`,
        emailVerified: true,
        name: "Token Owner",
      },
      { method: "oauth", oauth: { providerId: "github" } },
    );
    const browser = await context.internalAdapter.createSession(user.id, false);
    const cli = await context.internalAdapter.createSession(user.id, false);
    if (!browser || !cli) throw new Error("test session was not created");
    return { profile, auth, app, context, user, browser, cli };
  };

  test("get-session and list-sessions never return a session token", async () => {
    const { profile, app, browser, cli } = await setup();
    const bearer = `Bearer ${await signBearerToken(testAuthSecret, browser.token)}`;
    const current = await app.request(
      `${profile.origin}/api/auth/get-session`,
      {
        headers: { Origin: profile.webOrigin, Authorization: bearer },
      },
    );
    expect(current.status).toBe(200);
    const currentText = await current.text();
    expect(currentText).not.toContain(browser.token);
    expect(JSON.parse(currentText)).toMatchObject({
      session: { id: browser.id },
    });
    const listed = await app.request(
      `${profile.origin}/api/auth/list-sessions`,
      {
        headers: { Origin: profile.webOrigin, Authorization: bearer },
      },
    );
    expect(listed.status).toBe(200);
    const listedText = await listed.text();
    expect(listedText).not.toContain(browser.token);
    expect(listedText).not.toContain(cli.token);
    expect(JSON.parse(listedText)).toHaveLength(2);
  });

  test("an unsigned session token is not a bearer credential", async () => {
    const { profile, app, browser } = await setup();
    const raw = await app.request(`${profile.origin}/api/v1/session`, {
      headers: { Authorization: `Bearer ${browser.token}` },
    });
    expect(raw.status).toBe(401);
  });

  test("the device token endpoint hands the CLI a signed bearer token", async () => {
    const { profile, auth, app, context, user } = await setup();
    await context.adapter.create({
      model: "deviceCode",
      data: {
        deviceCode: "approved-device-code",
        userCode: "APPROVED",
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000),
        status: "approved",
        lastPolledAt: null,
        pollingInterval: 5000,
        clientId: "dotrelay-cli",
        scope: "",
      },
    });
    const response = await app.request(
      `${profile.origin}/api/auth/device/token`,
      {
        method: "POST",
        headers: { Origin: profile.origin, "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: "dotrelay-cli",
          device_code: "approved-device-code",
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { access_token: string };
    const [token, signature] = body.access_token.split(".");
    expect(token && signature).toBeTruthy();
    expect(
      await auth.api.getSession({
        headers: new Headers({ Authorization: `Bearer ${body.access_token}` }),
      }),
    ).not.toBeNull();
    expect(
      await auth.api.getSession({
        headers: new Headers({ Authorization: `Bearer ${token}` }),
      }),
    ).toBeNull();
  });
});
