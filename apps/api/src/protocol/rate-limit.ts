import { createProblem, sha384 } from "@dotrelay/contracts";
import type { Context, Next } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import Redis from "ioredis";

const PROTOCOL_RATE_LIMIT = 120;
const PROTOCOL_RATE_WINDOW_SECONDS = 60;

const INCREMENT_WITH_EXPIRE = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

let client: Redis | undefined;

const protocolRedis = (url: string): Redis => {
  client ??= new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  return client;
};

const actorRateLimitKey = async (context: Context): Promise<string> => {
  const actorMaterial =
    context.req.header("Authorization") ??
    context.req.header("X-DotRelay-Device-Id") ??
    "anonymous";
  const digest = await sha384(new TextEncoder().encode(actorMaterial));
  const actorKey = [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `dotrelay:protocol:${context.req.method}:${context.req.path}:${actorKey}`;
};

export const createProtocolRateLimit = (isProduction: boolean) => {
  return async (context: Context, next: Next) => {
    const url = process.env.VALKEY_URL ?? process.env.REDIS_URL;
    if (!url) {
      if (isProduction) {
        const problem = createProblem("rate_limit_unavailable");
        return context.json(problem, problem.status as ContentfulStatusCode, {
          "Cache-Control": "no-store",
          "Content-Type": "application/problem+json",
        });
      }
      await next();
      return;
    }
    const redis = protocolRedis(url);
    try {
      if (redis.status === "wait" || redis.status === "end")
        await redis.connect();
      const key = await actorRateLimitKey(context);
      const count = Number(
        await redis.eval(
          INCREMENT_WITH_EXPIRE,
          1,
          key,
          PROTOCOL_RATE_WINDOW_SECONDS.toString(),
        ),
      );
      if (count > PROTOCOL_RATE_LIMIT) {
        const problem = createProblem("rate_limited", {
          retryAfterSeconds: 60,
        });
        return context.json(problem, problem.status as ContentfulStatusCode, {
          "Cache-Control": "no-store",
          "Content-Type": "application/problem+json",
          "Retry-After": "60",
        });
      }
    } catch {
      const problem = createProblem("rate_limit_unavailable");
      return context.json(problem, problem.status as ContentfulStatusCode, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      });
    }
    await next();
  };
};
