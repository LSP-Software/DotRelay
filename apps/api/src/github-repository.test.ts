import { beforeEach, describe, expect, test } from "bun:test";
import type { DotRelayAuth } from "./auth";
import {
  clearGitHubRepositoryDisplayCache,
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

describe("repository display lookup", () => {
  beforeEach(() => clearGitHubRepositoryDisplayCache());

  const recordingFetch = (
    respond: (init?: RequestInit) => Response | Promise<Response>,
  ) => {
    const calls: Array<
      Readonly<{ url: string; authorization: string | null }>
    > = [];
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      return respond(init);
    }) as typeof fetch;
    return { calls, fetchImpl };
  };

  test("looks up a display name once and caches it for ten minutes", async () => {
    let time = 0;
    const { calls, fetchImpl } = recordingFetch(() =>
      Response.json({ full_name: "LSP-Software/DotRelay" }),
    );
    const options = { fetch: fetchImpl, now: () => time };

    const first = await lookupGitHubRepositoryDisplay("4242424242", options);
    time = 9 * 60 * 1000;
    const second = await lookupGitHubRepositoryDisplay("4242424242", options);
    expect(first).toEqual({ owner: "LSP-Software", name: "DotRelay" });
    expect(second).toEqual(first);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.github.com/repositories/4242424242",
    ]);

    time = 11 * 60 * 1000;
    await lookupGitHubRepositoryDisplay("4242424242", options);
    expect(calls).toHaveLength(2);
  });

  test("caches a 404 as a miss for the lookup scope", async () => {
    let time = 0;
    const { calls, fetchImpl } = recordingFetch(
      () => new Response(null, { status: 404 }),
    );
    const options = { fetch: fetchImpl, now: () => time, cacheScope: "a" };

    expect(
      await lookupGitHubRepositoryDisplay("4242424242", options),
    ).toBeUndefined();
    expect(
      await lookupGitHubRepositoryDisplay("4242424242", options),
    ).toBeUndefined();
    expect(calls).toHaveLength(1);

    // Another viewer's delegated access may see the repository.
    await lookupGitHubRepositoryDisplay("4242424242", {
      ...options,
      cacheScope: "b",
    });
    expect(calls).toHaveLength(2);

    time = 6 * 60 * 1000;
    await lookupGitHubRepositoryDisplay("4242424242", options);
    expect(calls).toHaveLength(3);
  });

  test("gives up after the timeout and retries only after a short pause", async () => {
    let time = 0;
    const { calls, fetchImpl } = recordingFetch(
      (init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const options = { fetch: fetchImpl, now: () => time, timeoutMs: 10 };

    expect(
      await lookupGitHubRepositoryDisplay("4242424242", options),
    ).toBeUndefined();
    expect(
      await lookupGitHubRepositoryDisplay("4242424242", options),
    ).toBeUndefined();
    expect(calls).toHaveLength(1);
    time = 2 * 60 * 1000;
    await lookupGitHubRepositoryDisplay("4242424242", options);
    expect(calls).toHaveLength(2);
  });

  test("uses the viewer's delegated access when available", async () => {
    const { calls, fetchImpl } = recordingFetch(() =>
      Response.json({ full_name: "LSP-Software/Private" }),
    );
    let tokenRequests = 0;
    const display = await lookupGitHubRepositoryDisplay("4242424242", {
      fetch: fetchImpl,
      accessToken: async () => {
        tokenRequests += 1;
        return "ghu_delegated-token";
      },
    });
    expect(display).toEqual({ owner: "LSP-Software", name: "Private" });
    expect(calls[0]?.authorization).toBe("Bearer ghu_delegated-token");

    // A cached name needs no token.
    await lookupGitHubRepositoryDisplay("4242424242", {
      fetch: fetchImpl,
      accessToken: async () => {
        tokenRequests += 1;
        return "ghu_delegated-token";
      },
    });
    expect(tokenRequests).toBe(1);
  });

  test("falls back to an anonymous lookup without delegated access", async () => {
    const { calls, fetchImpl } = recordingFetch(() =>
      Response.json({ full_name: "LSP-Software/DotRelay" }),
    );
    await lookupGitHubRepositoryDisplay("4242424242", {
      fetch: fetchImpl,
      accessToken: async () => {
        throw new Error("token store unavailable");
      },
    });
    expect(calls[0]?.authorization).toBeNull();
  });

  test("rejects a malformed repository id without a request", async () => {
    const { calls, fetchImpl } = recordingFetch(() => Response.json({}));
    expect(
      await lookupGitHubRepositoryDisplay("../users", { fetch: fetchImpl }),
    ).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
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
    delegatedAuth([
      { providerId: "github", accessToken: "ghu_delegated-token" },
    ]),
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
      authorization: "Bearer ghu_delegated-token",
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
      delegatedAuth([{ providerId: "github", accessToken: "ghu_t" }]),
      "auth-user",
      { owner: "LSP-Software", name: "DotRelay" },
      { fetch: fetchImpl, sleep: async () => undefined },
    );
    expect(outcome).toEqual({ code: "repository_access_denied" });
    expect(calls).toBe(1);
  }
});

test("a rejected credential is a definitive denial, not an outage", async () => {
  let calls = 0;
  const fetchImpl = (async (_input: string | URL | Request) => {
    calls += 1;
    return new Response("Bad credentials", { status: 401 });
  }) as typeof fetch;

  const outcome = await resolveGitHubRepositoryIdentity(
    delegatedAuth([{ providerId: "github", accessToken: "ghu_expired" }]),
    "auth-user",
    { owner: "LSP-Software", name: "DotRelay" },
    { fetch: fetchImpl, sleep: async () => undefined },
  );

  expect(outcome).toEqual({ code: "repository_access_denied" });
  expect(calls).toBe(1);
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
    delegatedAuth([{ providerId: "github", accessToken: "ghu_t" }]),
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
    delegatedAuth([{ providerId: "github", accessToken: "ghu_t" }]),
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
    delegatedAuth([{ providerId: "github", accessToken: "ghu_t" }]),
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
    delegatedAuth([{ providerId: "github", accessToken: "ghu_t" }]),
    "auth-user",
    { owner: "LSP-Software", name: "DotRelay" },
    { fetch: fetchImpl, sleep: async () => undefined },
  );

  expect(outcome).toEqual({ code: "github_unavailable" });
});

test("classic OAuth and personal tokens cannot supply delegated repository access", async () => {
  for (const token of [
    "gho_classic",
    "ghp_personal",
    "github_pat_finegrained",
  ]) {
    let called = false;
    const result = await resolveGitHubRepositoryIdentity(
      delegatedAuth([{ providerId: "github", accessToken: token }]),
      "auth-user",
      { owner: "LSP-Software", name: "DotRelay" },
      {
        fetch: (async () => {
          called = true;
          return Response.json({});
        }) as unknown as typeof fetch,
      },
    );
    expect(result.code).toBe("repository_access_denied");
    expect(called).toBe(false);
  }
});
