import { expect, test } from "bun:test";
import type { DotRelayAuth } from "./auth";
import {
  lookupGitHubRepositoryDisplay,
  parseGitHubRepositoryDisplay,
  resolveGitHubRepositoryIdentity,
} from "./github-repository";

test("parses a GitHub repository display name from the public API payload", () => {
  expect(
    parseGitHubRepositoryDisplay({
      full_name: "LSP-Software/DotRelay",
      name: "DotRelay",
      owner: { login: "LSP-Software" },
    }),
  ).toEqual({ owner: "LSP-Software", name: "DotRelay" });
});

test("looks up a GitHub repository display name once and caches it", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return Response.json({ full_name: "LSP-Software/DotRelay" });
  }) as typeof fetch;

  const first = await lookupGitHubRepositoryDisplay("4242424242", fetchImpl);
  const second = await lookupGitHubRepositoryDisplay("4242424242", fetchImpl);

  expect(first).toEqual({ owner: "LSP-Software", name: "DotRelay" });
  expect(second).toEqual(first);
  expect(calls).toEqual(["https://api.github.com/repositories/4242424242"]);
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

test("resolves the Repository Identity with the User's delegated access", async () => {
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
    return Response.json({
      id: 1311418611,
      full_name: "LSP-Software/DotRelay",
    });
  }) as typeof fetch;

  const outcome = await resolveGitHubRepositoryIdentity(
    delegatedAuth([{ providerId: "github", accessToken: "delegated-token" }]),
    "auth-user",
    { owner: "LSP-Software", name: "DotRelay" },
    { fetch: fetchImpl, sleep: async () => undefined },
  );

  expect(outcome).toEqual({
    code: "resolved",
    githubRepositoryId: "1311418611",
    owner: "LSP-Software",
    name: "DotRelay",
  });
  expect(calls).toEqual([
    {
      url: "https://api.github.com/repos/LSP-Software/DotRelay",
      authorization: "Bearer delegated-token",
    },
  ]);
});

test("a User without Delegated GitHub Access resolves nothing", async () => {
  let calls = 0;
  const fetchImpl = (async (_input: string | URL | Request) => {
    calls += 1;
    return Response.json({ id: 1, full_name: "a/b" });
  }) as typeof fetch;

  const empty = await resolveGitHubRepositoryIdentity(
    delegatedAuth([]),
    "auth-user",
    { owner: "LSP-Software", name: "DotRelay" },
    { fetch: fetchImpl, sleep: async () => undefined },
  );
  const other = await resolveGitHubRepositoryIdentity(
    delegatedAuth([]),
    "someone-else",
    { owner: "LSP-Software", name: "DotRelay" },
    { fetch: fetchImpl, sleep: async () => undefined },
  );
  const nonGitHub = await resolveGitHubRepositoryIdentity(
    delegatedAuth([{ providerId: "google", accessToken: "x" }]),
    "auth-user",
    { owner: "LSP-Software", name: "DotRelay" },
    { fetch: fetchImpl, sleep: async () => undefined },
  );

  expect(empty).toEqual({ code: "repository_access_denied" });
  expect(other).toEqual({ code: "repository_access_denied" });
  expect(nonGitHub).toEqual({ code: "repository_access_denied" });
  expect(calls).toBe(0);
});

test("GitHub denial and absence answer identically and never retry", async () => {
  for (const status of [403, 404]) {
    let calls = 0;
    const fetchImpl = (async (_input: string | URL | Request) => {
      calls += 1;
      return new Response("nope", { status });
    }) as typeof fetch;
    const outcome = await resolveGitHubRepositoryIdentity(
      delegatedAuth([{ providerId: "github", accessToken: "t" }]),
      "auth-user",
      { owner: "LSP-Software", name: "DotRelay" },
      { fetch: fetchImpl, sleep: async () => undefined },
    );
    expect(outcome).toEqual({ code: "repository_access_denied" });
    expect(calls).toBe(1);
  }
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
    return Response.json({
      id: 1311418611,
      full_name: "LSP-Software/DotRelay",
    });
  }) as typeof fetch;

  const outcome = await resolveGitHubRepositoryIdentity(
    delegatedAuth([{ providerId: "github", accessToken: "t" }]),
    "auth-user",
    { owner: "LSP-Software", name: "DotRelay" },
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
    githubRepositoryId: "1311418611",
    owner: "LSP-Software",
    name: "DotRelay",
  });
  expect(calls).toBe(3);
  // Each retry waits the server's Retry-After guidance (capped by the
  // remaining budget), never the sub-second base backoff.
  expect(sleeps).toEqual([30_000, 30_000]);
});

test("an exhausted rate limit reports the reset window from GitHub's headers", async () => {
  // Every attempt is rate limited, so the attempt budget is spent and the
  // final answer carries the x-ratelimit-reset window (130s epoch minus the
  // frozen 40s clock = 90s to reset).
  const now = () => 40_000;
  const fetchImpl = (async (_input: string | URL | Request) =>
    new Response("rate limited", {
      status: 429,
      headers: { "x-ratelimit-reset": "130" },
    })) as typeof fetch;

  const outcome = await resolveGitHubRepositoryIdentity(
    delegatedAuth([{ providerId: "github", accessToken: "t" }]),
    "auth-user",
    { owner: "LSP-Software", name: "DotRelay" },
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

  const outcome = await resolveGitHubRepositoryIdentity(
    delegatedAuth([{ providerId: "github", accessToken: "t" }]),
    "auth-user",
    { owner: "LSP-Software", name: "DotRelay" },
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

test("a 200 without a usable repository payload is an outage, not a denial", async () => {
  const fetchImpl = (async (_input: string | URL | Request) =>
    Response.json({ message: "Not Found" })) as typeof fetch;

  const outcome = await resolveGitHubRepositoryIdentity(
    delegatedAuth([{ providerId: "github", accessToken: "t" }]),
    "auth-user",
    { owner: "LSP-Software", name: "DotRelay" },
    { fetch: fetchImpl, sleep: async () => undefined },
  );

  expect(outcome).toEqual({ code: "github_unavailable" });
});
