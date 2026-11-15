import type Redis from "ioredis";
import { consumeValkeyRateLimit, rateLimitRedis } from "./protocol/rate-limit";

type RateLimitRule = Readonly<{ window: number; max: number }>;
type RateLimitDecision = { allowed: boolean; retryAfter: number | null };

export type AuthRateLimitStorage = Readonly<{
  consume: (key: string, rule: RateLimitRule) => Promise<RateLimitDecision>;
}>;

const MEMORY_MAX_ENTRIES = 100_000;

/**
 * A per-process fixed-window counter. It is the development default and the
 * fallback while Valkey is unreachable, so a Valkey outage degrades the
 * sign-in limiter to one budget per API instance instead of none.
 */
export const createMemoryRateLimitStorage = (
  now: () => number = Date.now,
): AuthRateLimitStorage => {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    consume: async (key, rule) => {
      const current = now();
      if (windows.size >= MEMORY_MAX_ENTRIES)
        for (const [entryKey, entry] of windows)
          if (entry.resetAt <= current) windows.delete(entryKey);
      if (windows.size >= MEMORY_MAX_ENTRIES) windows.clear();
      const entry = windows.get(key);
      if (!entry || entry.resetAt <= current) {
        windows.set(key, { count: 1, resetAt: current + rule.window * 1_000 });
        return { allowed: true, retryAfter: null };
      }
      entry.count += 1;
      if (entry.count <= rule.max) return { allowed: true, retryAfter: null };
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil((entry.resetAt - current) / 1_000)),
      };
    },
  };
};

/**
 * Better Auth's rate-limit storage on Valkey, so every API instance shares
 * one budget per client IP and path. Better Auth keys by the client IP it
 * resolves from `advanced.ipAddress`, which is only meaningful behind the
 * trusted proxies configured in the Server Profile (docs/wiki/operations.md).
 */
export const createValkeyRateLimitStorage = (
  redis: Redis,
  fallback: AuthRateLimitStorage = createMemoryRateLimitStorage(),
): AuthRateLimitStorage => ({
  consume: async (key, rule) => {
    try {
      const outcome = await consumeValkeyRateLimit(
        redis,
        `dotrelay:auth:${key}`,
        rule.max,
        rule.window,
      );
      return {
        allowed: outcome.allowed,
        retryAfter: outcome.allowed ? null : outcome.retryAfterSeconds,
      };
    } catch {
      return fallback.consume(key, rule);
    }
  },
});

/** Valkey-backed storage when Valkey is configured; otherwise undefined. */
export const authRateLimitStorage = (
  url: string | undefined,
): AuthRateLimitStorage | undefined =>
  url ? createValkeyRateLimitStorage(rateLimitRedis(url)) : undefined;
