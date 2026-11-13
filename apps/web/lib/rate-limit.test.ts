import { expect, test } from "bun:test";
import { rateLimitedMessage, retryAfterSecondsFrom } from "./rate-limit";

test("the problem body's retryAfterSeconds wins over headers", () => {
  expect(
    retryAfterSecondsFrom(
      { code: "rate_limited", retryAfterSeconds: 12 },
      new Headers({ "Retry-After": "40" }),
    ),
  ).toBe(12);
});

test("Retry-After and X-Retry-After headers are read when the body has none", () => {
  expect(retryAfterSecondsFrom({}, new Headers({ "Retry-After": "40" }))).toBe(
    40,
  );
  expect(
    retryAfterSecondsFrom(null, new Headers({ "X-Retry-After": "7" })),
  ).toBe(7);
  const inTenSeconds = new Date(Date.now() + 10_000).toUTCString();
  const fromDate = retryAfterSecondsFrom(
    {},
    new Headers({ "Retry-After": inTenSeconds }),
  );
  expect(fromDate).toBeGreaterThanOrEqual(9);
  expect(fromDate).toBeLessThanOrEqual(11);
  expect(retryAfterSecondsFrom({ retryAfterSeconds: -1 })).toBeUndefined();
});

test("the message names the wait when it is known", () => {
  expect(rateLimitedMessage(30)).toContain("Try again in 30 seconds.");
  expect(rateLimitedMessage(1)).toContain("Try again in 1 second.");
  expect(rateLimitedMessage()).toContain("Wait a moment");
});
