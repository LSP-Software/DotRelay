import { createProblem, sha384 } from "@dotrelay/contracts";
import type { Context, Next } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import Redis from "ioredis";
import type { ProtocolActor } from "./context";

// A single publication may stage up to 256 objects.
const PROTOCOL_RATE_LIMIT = 600;
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

export const actorRateLimitKey = async (userId: string): Promise<string> => {
  const digest = await sha384(new TextEncoder().encode(userId));
  const actorKey = [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `dotrelay:protocol:user:${actorKey}`;
};

export const createProtocolRateLimit = (
  isProduction: boolean,
  authenticate: (context: Context) => Promise<ProtocolActor | Response>,
) => {
  return async (context: Context, next: Next) => {
    // Never trust caller-chosen tokens or Device ids as bucket identities.
    const actor = await authenticate(context);
    if (actor instanceof Response) return actor;
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
      const key = await actorRateLimitKey(actor.userId);
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
