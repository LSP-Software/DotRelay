import { describe, expect, test } from "bun:test";
import {
  type FetchBudget,
  fetchWithDeadline,
  fetchWithinBudget,
  NetworkAttemptError,
  type NetworkPolicy,
  type RetryDecision,
  type RetryListener,
  retryAfterMsFromResponse,
  retryDelay,
  transientResponseVerdict,
} from "./network";

const fastPolicy = (overrides: Partial<NetworkPolicy> = {}): NetworkPolicy => ({
  requestDeadlineMs: 25,
  maxAttempts: 3,
  retryBaseDelayMs: 5,
  retryMaxDelayMs: 20,
  sleep: async () => undefined,
  now: () => 0,
  ...overrides,
});

const budget = (
  policy: NetworkPolicy,
  options: Readonly<{
    readonly verdict?: (response: Response) => RetryDecision;
    readonly onRetry?: RetryListener;
  }> = {},
): FetchBudget => ({
  policy,
  ...(options.verdict || options.onRetry
    ? {
        retry: {
          ...(options.verdict ? { verdict: options.verdict } : {}),
          ...(options.onRetry ? { onRetry: options.onRetry } : {}),
        },
      }
    : {}),
});

const retryBudget = (
  policy: NetworkPolicy,
  onRetry?: RetryListener,
): FetchBudget => ({
  policy,
  retry: { ...(onRetry ? { onRetry } : {}) },
});

const transientBudget = (policy: NetworkPolicy): FetchBudget => ({
  policy,
  retry: {
    verdict: (response) => transientResponseVerdict(response, policy.now),
  },
});

const endpoint = "https://relay.example/api";

describe("cancellable fetch deadlines", () => {
  test("settles a stalled fetch as a stalled failure instead of hanging", async () => {
    const neverSettling = async (): Promise<Response> =>
      new Promise<Response>(() => undefined);
    const started = Date.now();
    await expect(
      fetchWithDeadline(
        neverSettling,
        endpoint,
        {},
        fastPolicy({ requestDeadlineMs: 25 }),
      ),
    ).rejects.toMatchObject({ name: "NetworkAttemptError" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("keeps a fetch that settles before the deadline", async () => {
    const response = await fetchWithDeadline(
      async () => Response.json({ ok: true }),
      endpoint,
      {},
      fastPolicy({ requestDeadlineMs: 25 }),
    );
    expect(response.status).toBe(200);
  });

  test("classifies an unreachable endpoint as offline", async () => {
    await expect(
      fetchWithDeadline(
        async () => {
          throw new TypeError("fetch failed");
        },
        endpoint,
        {},
        fastPolicy(),
      ),
    ).rejects.toMatchObject({ failure: { kind: "offline" } });
  });

  test("classifies a deadline abort as stalled, not offline", async () => {
    const started = Date.now();
    let error: unknown;
    try {
      await fetchWithDeadline(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(() => resolve(Response.json({})), 500);
          }),
        endpoint,
        {},
        fastPolicy({ requestDeadlineMs: 25 }),
      );
    } catch (value) {
      error = value;
    }
    expect(Date.now() - started).toBeLessThan(500);
    expect(error).toBeInstanceOf(NetworkAttemptError);
    expect((error as NetworkAttemptError).failure).toMatchObject({
      kind: "stalled",
    });
  });
});

describe("bounded retries for safe operations", () => {
  test("retries transient failures within the budget and succeeds", async () => {
    let calls = 0;
    const fetcher = async (): Promise<Response> => {
      calls += 1;
      if (calls <= 2) throw new TypeError("fetch failed");
      return Response.json({ ok: true });
    };
    const result = await fetchWithinBudget(
      fetcher,
      endpoint,
      {},
      retryBudget(fastPolicy()),
    );
    expect(result.response.status).toBe(200);
    expect(result.attempts).toBe(3);
  });

  test("throws the exhausted network failure after the last attempt", async () => {
    const retries: number[] = [];
    const onRetry: RetryListener = (event) => void retries.push(event.attempt);
    await expect(
      fetchWithinBudget(
        async () => {
          throw new TypeError("fetch failed");
        },
        endpoint,
        {},
        retryBudget(fastPolicy(), onRetry),
      ),
    ).rejects.toBeInstanceOf(NetworkAttemptError);
    // Retries are reported after attempts 1 and 2; attempt 3 is final.
    expect(retries).toEqual([1, 2]);
  });

  test("backs off between attempts and caps the delay", async () => {
    const policy = fastPolicy();
    expect(retryDelay(1, policy)).toBe(5);
    expect(retryDelay(2, policy)).toBe(10);
    expect(retryDelay(3, policy)).toBe(20);
    expect(retryDelay(4, policy)).toBe(20);
  });

  test("respects a server Retry-After wait over backoff", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetcher = async (): Promise<Response> => {
      calls += 1;
      if (calls === 1)
        return new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "7" },
        });
      return Response.json({ ok: true });
    };
    const policy = fastPolicy({ sleep: async (ms) => void sleeps.push(ms) });
    const result = await fetchWithinBudget(
      fetcher,
      endpoint,
      {},
      transientBudget(policy),
    );
    expect(result.attempts).toBe(2);
    expect(sleeps).toEqual([7000]);
  });

  test("retries 5xx answers and returns the last answer when the budget is spent", async () => {
    const policy = fastPolicy({ maxAttempts: 2 });
    const fetcher = async (): Promise<Response> =>
      new Response("unavailable", {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    const result = await fetchWithinBudget(
      fetcher,
      endpoint,
      {},
      transientBudget(policy),
    );
    expect(result.response.status).toBe(503);
    expect(result.attempts).toBe(2);
  });

  test("never retries a final verdict, even for 4xx answers", async () => {
    const policy = fastPolicy();
    const fetcher = async (): Promise<Response> =>
      Response.json({ code: "authentication_required" }, { status: 401 });
    const result = await fetchWithinBudget(
      fetcher,
      endpoint,
      {},
      transientBudget(policy),
    );
    expect(result.response.status).toBe(401);
    expect(result.attempts).toBe(1);
  });

  test("a deadline-only budget never repeats the operation", async () => {
    let calls = 0;
    await expect(
      fetchWithinBudget(
        async () => {
          calls += 1;
          throw new TypeError("fetch failed");
        },
        endpoint,
        {},
        budget(fastPolicy()),
      ),
    ).rejects.toBeInstanceOf(NetworkAttemptError);
    expect(calls).toBe(1);
  });
});

describe("retry-after guidance", () => {
  test("reads seconds from Retry-After or X-Retry-After", () => {
    expect(
      retryAfterMsFromResponse(
        new Response(null, { headers: { "Retry-After": "60" } }),
        () => 0,
      ),
    ).toBe(60_000);
    expect(
      retryAfterMsFromResponse(
        new Response(null, { headers: { "X-Retry-After": "2" } }),
        () => 0,
      ),
    ).toBe(2_000);
  });

  test("caps a pathological retry-after at ten minutes", () => {
    expect(
      retryAfterMsFromResponse(
        new Response(null, { headers: { "Retry-After": "999999" } }),
        () => 0,
      ),
    ).toBe(600_000);
  });

  test("ignores unparseable retry-after values", () => {
    expect(
      retryAfterMsFromResponse(
        new Response(null, { headers: { "Retry-After": "soon" } }),
        () => 0,
      ),
    ).toBeUndefined();
  });
});
