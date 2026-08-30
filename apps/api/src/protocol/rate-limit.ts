import { createProblem } from "@dotrelay/contracts";
import type { Context, Next } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import Redis from "ioredis";

const PROTOCOL_RATE_LIMIT = 120;
const PROTOCOL_RATE_WINDOW_SECONDS = 60;

let client: Redis | undefined;

const protocolRedis = (url: string): Redis => {
  client ??= new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  return client;
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
      if (redis.status !== "ready") await redis.connect();
      const actorKey =
        context.req.header("Authorization") ??
        context.req.header("X-DotRelay-Device-Id") ??
        "anonymous";
      const key = `dotrelay:protocol:${context.req.method}:${context.req.path}:${actorKey}`;
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, PROTOCOL_RATE_WINDOW_SECONDS);
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
