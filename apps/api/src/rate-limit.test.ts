import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import type Redis from "ioredis";
import {
  createMemoryRateLimitStorage,
  createValkeyRateLimitStorage,
} from "./auth-rate-limit";
import {
  API_RATE_LIMIT_BUCKETS,
  apiRateLimitBuckets,
  consumeValkeyRateLimit,
  createUserRateLimit,
} from "./protocol/rate-limit";

const savedValkeyUrl = process.env.VALKEY_URL;
const savedRedisUrl = process.env.REDIS_URL;
afterEach(() => {
  if (savedValkeyUrl === undefined) delete process.env.VALKEY_URL;
  else process.env.VALKEY_URL = savedValkeyUrl;
  if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = savedRedisUrl;
});

// An in-process stand-in for the Valkey INCR/EXPIRE script.
const fakeRedis = (options: { readonly fail?: boolean } = {}) => {
  const counters = new Map<string, number>();
  return {
    status: "ready",
    eval: async (
      _script: string,
      _keys: number,
      key: string,
      windowSeconds: string,
    ) => {
      if (options.fail) throw new Error("valkey unavailable");
      const count = (counters.get(key) ?? 0) + 1;
      counters.set(key, count);
      return [count, Number(windowSeconds)];
    },
    counters,
  } as unknown as Redis & { counters: Map<string, number> };
};

test("every authenticated route counts against the general bucket; GitHub and row-creating routes also against tighter ones", () => {
  const names = (method: string, path: string) =>
    apiRateLimitBuckets(method, path).map((bucket) => bucket.name);
  expect(names("GET", "/api/v1/teams")).toEqual(["api"]);
  expect(names("PUT", "/api/v1/operations/x/staging/y")).toEqual(["api"]);
  for (const [method, path] of [
    ["GET", "/api/v1/github-repositories/resolve"],
    ["POST", "/api/v1/github-users/resolve"],
    ["GET", "/api/v1/workspace/boundary"],
  ] as const)
    expect(names(method, path)).toEqual(["api", "github"]);
  for (const [method, path] of [
    ["POST", "/api/v1/teams"],
    ["POST", "/api/v1/teams/team-id/invitations"],
    ["POST", "/api/v1/projects"],
    ["POST", "/api/v1/devices/enrollments"],
  ] as const)
    expect(names(method, path)).toEqual(["api", "create"]);
  // Reads and follow-up steps of those resources are not row creations.
  expect(names("GET", "/api/v1/teams/team-id/invitations")).toEqual(["api"]);
  expect(
    names("POST", "/api/v1/teams/team-id/invitations/inv-id/revoke"),
  ).toEqual(["api"]);
  expect(API_RATE_LIMIT_BUCKETS.github.limit).toBeLessThan(
    API_RATE_LIMIT_BUCKETS.general.limit,
  );
  expect(
    API_RATE_LIMIT_BUCKETS.create.limit /
      API_RATE_LIMIT_BUCKETS.create.windowSeconds,
  ).toBeLessThan(
    API_RATE_LIMIT_BUCKETS.general.limit /
      API_RATE_LIMIT_BUCKETS.general.windowSeconds,
  );
});

test("the Valkey counter allows up to the limit and reports the window remainder", async () => {
  const redis = fakeRedis();
  for (let index = 0; index < 3; index += 1)
    expect(
      (await consumeValkeyRateLimit(redis, "key", 3, 60)).allowed,
    ).toBeTrue();
  expect(await consumeValkeyRateLimit(redis, "key", 3, 60)).toEqual({
    allowed: false,
    retryAfterSeconds: 60,
  });
});

const limitedApp = (
  options: Readonly<{
    isProduction: boolean;
    subject: string | null;
  }>,
) => {
  const app = new Hono();
  let reached = 0;
  app.use(
    "*",
    createUserRateLimit({
      isProduction: options.isProduction,
      identify: async () => options.subject,
      buckets: () => [{ name: "test", limit: 1, windowSeconds: 60 }],
    }),
  );
  app.get("*", (context) => {
    reached += 1;
    return context.text("ok");
  });
  return { app, reached: () => reached };
};

test("without Valkey, production fails closed for signed-in callers and development runs unlimited", async () => {
  delete process.env.VALKEY_URL;
  delete process.env.REDIS_URL;
  const production = limitedApp({ isProduction: true, subject: "user" });
  const response = await production.app.request("/api/v1/teams");
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    code: "rate_limit_unavailable",
  });
  // An unauthenticated request reaches the route, which answers 401 itself.
  const anonymous = limitedApp({ isProduction: true, subject: null });
  expect((await anonymous.app.request("/api/v1/teams")).status).toBe(200);
  const development = limitedApp({ isProduction: false, subject: "user" });
  for (let index = 0; index < 3; index += 1)
    expect((await development.app.request("/api/v1/teams")).status).toBe(200);
});

test.skipIf(!process.env.VALKEY_URL)(
  "a signed-in User past a bucket is refused with Retry-After",
  async () => {
    const limited = limitedApp({
      isProduction: true,
      subject: `rate-limit-test-${crypto.randomUUID()}`,
    });
    expect((await limited.app.request("/api/v1/teams")).status).toBe(200);
    const refused = await limited.app.request("/api/v1/teams");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await refused.json()).toMatchObject({ code: "rate_limited" });
    expect(limited.reached()).toBe(1);
  },
);

test("Better Auth's limiter shares Valkey counters and falls back to memory when Valkey fails", async () => {
  const redis = fakeRedis();
  const storage = createValkeyRateLimitStorage(redis);
  const rule = { window: 60, max: 2 };
  expect(await storage.consume("1.2.3.4|/sign-in", rule)).toEqual({
    allowed: true,
    retryAfter: null,
  });
  await storage.consume("1.2.3.4|/sign-in", rule);
  expect(await storage.consume("1.2.3.4|/sign-in", rule)).toEqual({
    allowed: false,
    retryAfter: 60,
  });
  expect([...redis.counters.keys()]).toEqual([
    "dotrelay:auth:1.2.3.4|/sign-in",
  ]);

  let now = 0;
  const fallback = createMemoryRateLimitStorage(() => now);
  const failing = createValkeyRateLimitStorage(
    fakeRedis({ fail: true }),
    fallback,
  );
  expect((await failing.consume("ip|/path", rule)).allowed).toBeTrue();
  expect((await failing.consume("ip|/path", rule)).allowed).toBeTrue();
  expect(await failing.consume("ip|/path", rule)).toEqual({
    allowed: false,
    retryAfter: 60,
  });
  now += 60_000;
  expect((await failing.consume("ip|/path", rule)).allowed).toBeTrue();
});
