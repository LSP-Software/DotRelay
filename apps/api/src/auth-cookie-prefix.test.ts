import { expect, test } from "bun:test";
import { createInMemoryAuth } from "./auth";
import { loadServerProfileConfig } from "./profile";

// Hosted dev and production share the dotrelay.dev cookie domain, so they rely
// on COOKIE_PREFIX to keep their session cookies apart. This checks the option
// reaches Better Auth without calling sign-in, whose rate limit is shared with
// index.test.ts.
const authFor = (prefix?: string) =>
  createInMemoryAuth(
    loadServerProfileConfig({
      NODE_ENV: "test",
      SERVER_PROFILE_ORIGIN: "https://dev-api.dotrelay.dev",
      WEB_ORIGIN: "https://dev.dotrelay.dev",
      COOKIE_DOMAIN: "dotrelay.dev",
      BETTER_AUTH_SECRET: "x".repeat(32),
      ...(prefix ? { COOKIE_PREFIX: prefix } : {}),
    }),
  );

test("Better Auth keeps its default cookie prefix when COOKIE_PREFIX is unset", () => {
  expect(authFor().options.advanced?.cookiePrefix).toBeUndefined();
});

test("COOKIE_PREFIX is passed to Better Auth", () => {
  expect(authFor("dotrelay-dev").options.advanced?.cookiePrefix).toBe(
    "dotrelay-dev",
  );
});
