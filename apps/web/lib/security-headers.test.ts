import { expect, test } from "bun:test";
import {
  buildContentSecurityPolicy,
  buildSecurityHeaders,
  createNonce,
} from "./security-headers";

const directives = (policy: string): Map<string, string[]> =>
  new Map(
    policy.split("; ").map((directive) => {
      const [name = "", ...values] = directive.split(" ");
      return [name, values];
    }),
  );

test("the production policy is nonce-based and allows only the API origin", () => {
  const policy = directives(
    buildContentSecurityPolicy({
      nonce: "abc123",
      apiOrigin: "https://api.dotrelay.test/some/path",
      development: false,
      production: true,
    }),
  );
  expect(policy.get("default-src")).toEqual(["'self'"]);
  expect(policy.get("script-src")).toEqual([
    "'self'",
    "'nonce-abc123'",
    "'strict-dynamic'",
  ]);
  expect(policy.get("connect-src")).toEqual([
    "'self'",
    "https://api.dotrelay.test",
  ]);
  expect(policy.get("img-src")).toEqual([
    "'self'",
    "data:",
    "https://avatars.githubusercontent.com",
  ]);
  expect(policy.get("worker-src")).toEqual(["'self'", "blob:"]);
  expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
  expect(policy.get("base-uri")).toEqual(["'none'"]);
  expect(policy.get("form-action")).toEqual(["'self'"]);
  expect(policy.get("object-src")).toEqual(["'none'"]);
});

test("unsafe-eval is allowed only in development", () => {
  const dev = buildContentSecurityPolicy({
    nonce: "n",
    development: true,
    production: false,
  });
  expect(directives(dev).get("script-src")).toContain("'unsafe-eval'");
  const prod = buildContentSecurityPolicy({
    nonce: "n",
    development: false,
    production: true,
  });
  expect(prod).not.toContain("unsafe-eval");
});

test("a missing or malformed API origin leaves connect-src same-origin", () => {
  for (const apiOrigin of [undefined, "", "not a url"]) {
    const policy = buildContentSecurityPolicy({
      nonce: "n",
      apiOrigin,
      development: false,
      production: true,
    });
    expect(directives(policy).get("connect-src")).toEqual(["'self'"]);
  }
});

test("static security headers are set, with HSTS only in production", () => {
  const production = buildSecurityHeaders({
    nonce: "n",
    development: false,
    production: true,
  });
  expect(production["Referrer-Policy"]).toBe("no-referrer");
  expect(production["X-Content-Type-Options"]).toBe("nosniff");
  expect(production["X-Frame-Options"]).toBe("DENY");
  expect(production["Permissions-Policy"]).toBe(
    "camera=(), microphone=(), geolocation=()",
  );
  expect(production["Strict-Transport-Security"]).toContain("max-age=");

  const development = buildSecurityHeaders({
    nonce: "n",
    development: true,
    production: false,
  });
  expect(development["Strict-Transport-Security"]).toBeUndefined();
});

test("nonces are fresh base64 values", () => {
  const first = createNonce();
  expect(first).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  expect(createNonce()).not.toBe(first);
});
