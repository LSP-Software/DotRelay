import { createProblem, sha384 } from "@dotrelay/contracts";
import type { Context, Next } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import Redis from "ioredis";
import type { ProtocolActor } from "./context";

export type RateLimitBucket = Readonly<{
  /** Part of the Valkey key; buckets never share counters. */
  readonly name: string;
  readonly limit: number;
  readonly windowSeconds: number;
}>;

/**
 * Per-User request budgets for authenticated /api/v1 routes. Every request
 * counts against `general`; routes that call GitHub on the User's behalf or
 * create durable rows also count against a tighter bucket.
 */
export const API_RATE_LIMIT_BUCKETS = Object.freeze({
  // A single publication may stage up to 256 objects.
  general: Object.freeze({ name: "api", limit: 600, windowSeconds: 60 }),
  // Each request may spend the User's own GitHub API budget.
  github: Object.freeze({ name: "github", limit: 120, windowSeconds: 60 }),
  // Teams, Projects, invitations, and Device enrollments are durable rows.
  create: Object.freeze({ name: "create", limit: 60, windowSeconds: 3600 }),
  // Account exports read every row the service holds about the User.
  export: Object.freeze({ name: "export", limit: 10, windowSeconds: 3600 }),
} satisfies Record<string, RateLimitBucket>);

const PROTOCOL_BUCKET: RateLimitBucket = Object.freeze({
  name: "protocol",
  limit: 600,
  windowSeconds: 60,
});

const githubRoutes: ReadonlyArray<readonly [string, RegExp]> = [
  ["GET", /^\/api\/v1\/github-repositories\/resolve$/],
  ["POST", /^\/api\/v1\/github-users\/resolve$/],
  ["GET", /^\/api\/v1\/workspace\/boundary$/],
];

const createRoutes: ReadonlyArray<readonly [string, RegExp]> = [
  ["POST", /^\/api\/v1\/teams$/],
  ["POST", /^\/api\/v1\/teams\/[^/]+\/invitations$/],
  ["POST", /^\/api\/v1\/projects$/],
  ["POST", /^\/api\/v1\/devices\/enrollments$/],
  // Destructive lifecycle changes share the durable-row budget.
  ["POST", /^\/api\/v1\/teams\/[^/]+\/(leave|delete)$/],
  ["POST", /^\/api\/v1\/account\/delete$/],
];

const exportRoutes: ReadonlyArray<readonly [string, RegExp]> = [
  ["GET", /^\/api\/v1\/account\/export$/],
];

const matches = (
  routes: ReadonlyArray<readonly [string, RegExp]>,
  method: string,
  path: string,
) =>
  routes.some(
    ([routeMethod, pattern]) => routeMethod === method && pattern.test(path),
  );

/** The buckets a request to `method path` counts against. */
export const apiRateLimitBuckets = (
  method: string,
  path: string,
): readonly RateLimitBucket[] => [
  API_RATE_LIMIT_BUCKETS.general,
  ...(matches(githubRoutes, method, path)
    ? [API_RATE_LIMIT_BUCKETS.github]
    : []),
  ...(matches(createRoutes, method, path)
    ? [API_RATE_LIMIT_BUCKETS.create]
    : []),
  ...(matches(exportRoutes, method, path)
    ? [API_RATE_LIMIT_BUCKETS.export]
    : []),
];

// Returns the new count and the key's remaining lifetime in seconds.
const INCREMENT_WITH_EXPIRE = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

let client: Redis | undefined;

export const rateLimitRedis = (url: string): Redis => {
  client ??= new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  return client;
};

export const configuredValkeyUrl = (): string | undefined =>
  process.env.VALKEY_URL ?? process.env.REDIS_URL;

/**
 * Counts one request against `key` in a fixed window and reports whether it
 * is within `limit`. Throws when Valkey cannot be reached.
 */
export const consumeValkeyRateLimit = async (
  redis: Redis,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> => {
  if (redis.status === "wait" || redis.status === "end") await redis.connect();
  const [count, ttl] = (await redis.eval(
    INCREMENT_WITH_EXPIRE,
    1,
    key,
    windowSeconds.toString(),
  )) as [number, number];
  return {
    allowed: Number(count) <= limit,
    retryAfterSeconds: Math.max(1, Number(ttl) || windowSeconds),
  };
};

// Readiness probe for the configured Valkey. Unconfigured counts as ready
// (development); production configuration requires VALKEY_URL.
export const valkeyReady = async (
  url: string | undefined = configuredValkeyUrl(),
  timeoutMs = 2000,
): Promise<boolean> => {
  if (!url) return true;
  const redis = rateLimitRedis(url);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        if (redis.status === "wait" || redis.status === "end")
          await redis.connect();
        return (await redis.ping()) === "PONG";
      })(),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const subjectDigest = async (subject: string): Promise<string> => {
  const digest = await sha384(new TextEncoder().encode(subject));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const actorRateLimitKey = async (
  userId: string,
  bucket = PROTOCOL_BUCKET.name,
): Promise<string> => `dotrelay:${bucket}:user:${await subjectDigest(userId)}`;

/** The Hono context key naming the bucket that refused a request. */
export const RATE_LIMIT_BUCKET_CONTEXT_KEY = "rateLimitBucket";

const problemResponse = (
  context: Context,
  code: "rate_limited" | "rate_limit_unavailable",
  retryAfterSeconds?: number,
) => {
  const problem = createProblem(
    code,
    retryAfterSeconds === undefined ? undefined : { retryAfterSeconds },
  );
  return context.json(problem, problem.status as ContentfulStatusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/problem+json",
    ...(retryAfterSeconds === undefined
      ? {}
      : { "Retry-After": retryAfterSeconds.toString() }),
  });
};

/**
 * A per-User limiter backed by Valkey. `identify` names the bucket owner
 * from server-verified state (never a caller-chosen header); `null` lets an
 * unauthenticated request through to the route, which rejects it. Without
 * Valkey, production fails closed and development runs unlimited.
 */
export const createUserRateLimit = (
  options: Readonly<{
    readonly isProduction: boolean;
    readonly identify: (context: Context) => Promise<string | null | Response>;
    readonly buckets: (context: Context) => readonly RateLimitBucket[];
  }>,
) => {
  return async (context: Context, next: Next) => {
    const subject = await options.identify(context);
    if (subject instanceof Response) return subject;
    if (subject === null) {
      await next();
      return;
    }
    const url = configuredValkeyUrl();
    if (!url) {
      if (options.isProduction)
        return problemResponse(context, "rate_limit_unavailable");
      await next();
      return;
    }
    try {
      const redis = rateLimitRedis(url);
      for (const bucket of options.buckets(context)) {
        const outcome = await consumeValkeyRateLimit(
          redis,
          await actorRateLimitKey(subject, bucket.name),
          bucket.limit,
          bucket.windowSeconds,
        );
        if (!outcome.allowed) {
          // Read by the request metrics; the bucket name is a fixed token.
          context.set(RATE_LIMIT_BUCKET_CONTEXT_KEY as never, bucket.name);
          return problemResponse(
            context,
            "rate_limited",
            outcome.retryAfterSeconds,
          );
        }
      }
    } catch {
      return problemResponse(context, "rate_limit_unavailable");
    }
    await next();
  };
};

export const createProtocolRateLimit = (
  isProduction: boolean,
  authenticate: (context: Context) => Promise<ProtocolActor | Response>,
) =>
  createUserRateLimit({
    isProduction,
    // Never trust caller-chosen tokens or Device ids as bucket identities.
    identify: async (context) => {
      const actor = await authenticate(context);
      return actor instanceof Response ? actor : actor.userId;
    },
    buckets: () => [PROTOCOL_BUCKET],
  });
