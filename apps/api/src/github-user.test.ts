import { expect, test } from "bun:test";
import type { DotRelayAuth } from "./auth";
import { isValidGitHubLogin, resolveGitHubUserIdentity } from "./github-user";

test("validates GitHub login syntax without calling GitHub", () => {
  expect(isValidGitHubLogin("octocat")).toBe(true);
  expect(isValidGitHubLogin("a")).toBe(true);
  expect(isValidGitHubLogin("a-b")).toBe(true);
  expect(isValidGitHubLogin("A1-b2_C3".replace("_", "-"))).toBe(true);
  expect(isValidGitHubLogin("-octocat")).toBe(false);
  expect(isValidGitHubLogin("octocat-")).toBe(false);
  expect(isValidGitHubLogin("octo_cat")).toBe(false);
  expect(isValidGitHubLogin("")).toBe(false);
  expect(isValidGitHubLogin("a".repeat(40))).toBe(false);
});

// A stand-in for the better-auth instance: the seam only reads the acting
// User's stored OAuth accounts, and with no account-level token encryption
// configured the stored token is handed back as-is.
const delegatedAuth = (
  accounts: ReadonlyArray<
    Readonly<{ readonly providerId: string; readonly accessToken?: string }>
  >,
): DotRelayAuth =>
  ({
    $context: Promise.resolve({
      options: {},
      secretConfig: { secret: "test-secret" },
      internalAdapter: {
        findAccounts: async (userId: string) =>
          userId === "auth-user" ? accounts : [],
      },
    }),
  }) as unknown as DotRelayAuth;

test("resolves a familiar login to its stable GitHub user id", async () => {
  const calls: Array<Readonly<{ url: string; authorization: string | null }>> =
    [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("Authorization"),
    });
    return Response.json({ id: 583231, login: "octocat" });
  }) as typeof fetch;

  const outcome = await resolveGitHubUserIdentity(
    delegatedAuth([{ providerId: "github", accessToken: "delegated-token" }]),
    "auth-user",
    "octocat",
    { fetch: fetchImpl, sleep: async () => undefined },
  );

  expect(outcome).toEqual({
    code: "resolved",
    githubUserId: "583231",
    login: "octocat",
  });
  expect(calls).toEqual([
    {
      url: "https://api.github.com/users/octocat",
      authorization: "Bearer delegated-token",
    },
  ]);
});

test("a User without Delegated GitHub Access resolves nothing", async () => {
  let calls = 0;
  const fetchImpl = (async (_input: string | URL | Request) => {
    calls += 1;
    return Response.json({ id: 1, login: "a" });
  }) as typeof fetch;

  const empty = await resolveGitHubUserIdentity(
    delegatedAuth([]),
    "auth-user",
    "octocat",
    { fetch: fetchImpl, sleep: async () => undefined },
  );
  const other = await resolveGitHubUserIdentity(
    delegatedAuth([]),
    "someone-else",
    "octocat",
    { fetch: fetchImpl, sleep: async () => undefined },
  );
  const nonGitHub = await resolveGitHubUserIdentity(
    delegatedAuth([{ providerId: "google", accessToken: "x" }]),
    "auth-user",
    "octocat",
    { fetch: fetchImpl, sleep: async () => undefined },
  );

  expect(empty).toEqual({ code: "github_access_denied" });
  expect(other).toEqual({ code: "github_access_denied" });
  expect(nonGitHub).toEqual({ code: "github_access_denied" });
  expect(calls).toBe(0);
});

test("GitHub denial and absence answer identically and never retry", async () => {
  for (const status of [403, 404]) {
    let calls = 0;
    const fetchImpl = (async (_input: string | URL | Request) => {
      calls += 1;
      return new Response("nope", { status });
    }) as typeof fetch;
    const outcome = await resolveGitHubUserIdentity(
      delegatedAuth([{ providerId: "github", accessToken: "t" }]),
      "auth-user",
      "octocat",
      { fetch: fetchImpl, sleep: async () => undefined },
    );
    expect(outcome).toEqual({ code: "github_identity_not_found" });
    expect(calls).toBe(1);
  }
});

test("a secondary rate limit 403 is rate-limited, not a missing login", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const fetchImpl = (async (_input: string | URL | Request) => {
    calls += 1;
    return new Response("secondary rate limited", {
      status: 403,
      headers: { "Retry-After": "7" },
    });
  }) as typeof fetch;

  const outcome = await resolveGitHubUserIdentity(
    delegatedAuth([{ providerId: "github", accessToken: "t" }]),
    "auth-user",
    "octocat",
    {
      fetch: fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 0,
    },
  );

  expect(outcome).toEqual({
    code: "github_rate_limited",
    retryAfterSeconds: 7,
  });
  expect(calls).toBe(3);
  expect(sleeps).toEqual([7000, 7000]);
});

test("a 403 with an exhausted rate budget is treated as a rate limit", async () => {
  let calls = 0;
  const fetchImpl = (async (_input: string | URL | Request) => {
    calls += 1;
    return new Response("rate limited", {
      status: 403,
      headers: { "x-ratelimit-remaining": "0" },
    });
  }) as typeof fetch;

  const outcome = await resolveGitHubUserIdentity(
    delegatedAuth([{ providerId: "github", accessToken: "t" }]),
    "auth-user",
    "octocat",
    { fetch: fetchImpl, sleep: async () => undefined, now: () => 40_000 },
  );

  expect(outcome).toEqual({ code: "github_rate_limited" });
  expect(calls).toBe(3);
});

test("an invalid login is never sent to GitHub", async () => {
  let calls = 0;
  const fetchImpl = (async (_input: string | URL | Request) => {
    calls += 1;
    return Response.json({ id: 1, login: "a" });
  }) as typeof fetch;

  const outcome = await resolveGitHubUserIdentity(
    delegatedAuth([{ providerId: "github", accessToken: "t" }]),
    "auth-user",
    "not a login",
    { fetch: fetchImpl, sleep: async () => undefined },
  );

  expect(outcome).toEqual({ code: "github_identity_not_found" });
  expect(calls).toBe(0);
});

test("a rate limit is retried within budget and then resolved", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const fetchImpl = (async (_input: string | URL | Request) => {
    calls += 1;
    if (calls < 3)
      return new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "42" },
      });
    return Response.json({ id: 583231, login: "octocat" });
  }) as typeof fetch;

  const outcome = await resolveGitHubUserIdentity(
    delegatedAuth([{ providerId: "github", accessToken: "t" }]),
    "auth-user",
    "octocat",
    {
      fetch: fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 0,
    },
  );

  expect(outcome).toEqual({
    code: "resolved",
    githubUserId: "583231",
    login: "octocat",
  });
  expect(calls).toBe(3);
  expect(sleeps).toEqual([30_000, 30_000]);
});

test("an exhausted rate limit reports the reset window from GitHub's headers", async () => {
  const now = () => 40_000;
  const fetchImpl = (async (_input: string | URL | Request) =>
    new Response("rate limited", {
      status: 429,
      headers: { "x-ratelimit-reset": "130" },
    })) as typeof fetch;

  const outcome = await resolveGitHubUserIdentity(
    delegatedAuth([{ providerId: "github", accessToken: "t" }]),
    "auth-user",
    "octocat",
    { fetch: fetchImpl, sleep: async () => undefined, now },
  );

  expect(outcome).toEqual({
    code: "github_rate_limited",
    retryAfterSeconds: 90,
  });
});

test("an unreachable GitHub is retried within budget, then reported as an outage", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const fetchImpl = (async (
    _input: string | URL | Request,
  ): Promise<Response> => {
    calls += 1;
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  const outcome = await resolveGitHubUserIdentity(
    delegatedAuth([{ providerId: "github", accessToken: "t" }]),
    "auth-user",
    "octocat",
    {
      fetch: fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 0,
    },
  );

  expect(outcome).toEqual({ code: "github_unavailable" });
  expect(calls).toBe(3);
  expect(sleeps).toEqual([500, 1000]);
});

test("a 200 without a usable user payload is an outage, not a denial", async () => {
  const fetchImpl = (async (_input: string | URL | Request) =>
    Response.json({ message: "Not Found" })) as typeof fetch;

  const outcome = await resolveGitHubUserIdentity(
    delegatedAuth([{ providerId: "github", accessToken: "t" }]),
    "auth-user",
    "octocat",
    { fetch: fetchImpl, sleep: async () => undefined },
  );

  expect(outcome).toEqual({ code: "github_unavailable" });
});
