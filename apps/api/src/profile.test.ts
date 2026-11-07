import { describe, expect, test } from "bun:test";
import {
  hasMixedCredentials,
  isAllowedOrigin,
  isSecureRequest,
  loadServerProfileConfig,
  normalizeOrigin,
  sharedCookieDomain,
} from "./profile";

const githubOAuthEnvironment = {
  GITHUB_CLIENT_ID: "github-client",
  GITHUB_CLIENT_SECRET: "github-secret",
};

describe("Server Profile configuration", () => {
  test("normalizes an exact origin and rejects path-bearing origins", () => {
    expect(normalizeOrigin("https://relay.example/")).toBe(
      "https://relay.example",
    );
    expect(() => normalizeOrigin("https://relay.example/api")).toThrow();
  });

  test("allows HTTP only for loopback development profiles", () => {
    expect(
      normalizeOrigin("http://localhost:3001", { allowHttpLoopback: true }),
    ).toBe("http://localhost:3001");
    expect(() =>
      normalizeOrigin("http://relay.example", { allowHttpLoopback: true }),
    ).toThrow("HTTPS is required");
  });

  test("rejects the development secret in production", () => {
    expect(() =>
      loadServerProfileConfig({
        NODE_ENV: "production",
        SERVER_PROFILE_ORIGIN: "https://relay.example",
        SERVER_PROFILE_ID: "00000000-0000-4000-8000-000000000042",
      }),
    ).toThrow("BETTER_AUTH_SECRET");
  });

  test("rejects placeholder and weak production secrets and identifiers", () => {
    const production = {
      NODE_ENV: "production",
      SERVER_PROFILE_ORIGIN: "https://relay.example",
      SERVER_PROFILE_ID: "00000000-0000-4000-8000-000000000042",
      BETTER_AUTH_SECRET: "Zq7Xk2Lm9Pw4Rt6Yv8Bn3Cd5Fg1Hj0Ks",
      GITHUB_CLIENT_ID: "Iv1.test",
      GITHUB_CLIENT_SECRET: "github-secret",
    };
    expect(() => loadServerProfileConfig(production)).not.toThrow();
    expect(() =>
      loadServerProfileConfig({
        ...production,
        BETTER_AUTH_SECRET: "replace-with-at-least-32-random-characters",
      }),
    ).toThrow("placeholder");
    expect(() =>
      loadServerProfileConfig({
        ...production,
        BETTER_AUTH_SECRET: "Replace-With-my-own-very-long-secret-value",
      }),
    ).toThrow("placeholder");
    expect(() =>
      loadServerProfileConfig({
        ...production,
        BETTER_AUTH_SECRET: "x".repeat(40),
      }),
    ).toThrow("distinct characters");
    expect(() =>
      loadServerProfileConfig({
        ...production,
        SERVER_PROFILE_ID: "00000000-0000-4000-8000-000000000001",
      }),
    ).toThrow("uuidgen");
    expect(() =>
      loadServerProfileConfig({
        ...production,
        DATABASE_URL: "postgresql://dotrelay:dotrelay@db:5432/dotrelay",
      }),
    ).toThrow("DATABASE_URL");
    expect(() =>
      loadServerProfileConfig({
        NODE_ENV: "test",
        BETTER_AUTH_SECRET: "x".repeat(40),
        DATABASE_URL: "postgresql://dotrelay:dotrelay@db:5432/dotrelay",
      }),
    ).not.toThrow();
  });

  test("requires a complete GitHub OAuth configuration in production", () => {
    const production = {
      NODE_ENV: "production",
      SERVER_PROFILE_ORIGIN: "https://relay.example",
      SERVER_PROFILE_ID: "00000000-0000-4000-8000-000000000042",
      BETTER_AUTH_SECRET: "Zq7Xk2Lm9Pw4Rt6Yv8Bn3Cd5Fg1Hj0Ks",
    };
    expect(() => loadServerProfileConfig(production)).toThrow(
      "GITHUB_CLIENT_ID",
    );
    expect(() =>
      loadServerProfileConfig({
        ...production,
        GITHUB_CLIENT_ID: "github-client",
      }),
    ).toThrow("configured together");
    expect(
      loadServerProfileConfig({
        ...production,
        GITHUB_CLIENT_ID: "github-client",
        GITHUB_CLIENT_SECRET: "github-secret",
      }).githubClientId,
    ).toBe("github-client");
  });

  test("accepts lower operational quotas but never raises protocol ceilings", () => {
    const profile = loadServerProfileConfig({
      ...githubOAuthEnvironment,
      NODE_ENV: "production",
      SERVER_PROFILE_ORIGIN: "https://relay.example",
      BETTER_AUTH_SECRET: "Zq7Xk2Lm9Pw4Rt6Yv8Bn3Cd5Fg1Hj0Ks",
      ADMIN_BODY_BYTES: "1024",
      SERVER_PROFILE_ID: "00000000-0000-4000-8000-000000000042",
    });
    expect(profile.origin).toBe("https://relay.example");
    expect(profile.limits.adminBodyBytes).toBe(1024);
    expect(() =>
      loadServerProfileConfig({
        ...githubOAuthEnvironment,
        NODE_ENV: "production",
        SERVER_PROFILE_ORIGIN: "https://relay.example",
        BETTER_AUTH_SECRET: "Zq7Xk2Lm9Pw4Rt6Yv8Bn3Cd5Fg1Hj0Ks",
        ADMIN_BODY_BYTES: "300000",
        SERVER_PROFILE_ID: "00000000-0000-4000-8000-000000000042",
      }),
    ).toThrow("protocol ceiling");
  });

  test("accepts only the configured browser or Server Profile origin", () => {
    const profile = loadServerProfileConfig({
      WEB_ORIGIN: "https://app.example",
      SERVER_PROFILE_ORIGIN: "https://api.example",
      BETTER_AUTH_SECRET: "Zq7Xk2Lm9Pw4Rt6Yv8Bn3Cd5Fg1Hj0Ks",
    });
    expect(isAllowedOrigin("https://app.example", profile)).toBe(true);
    expect(isAllowedOrigin("https://api.example", profile)).toBe(true);
    expect(isAllowedOrigin("https://attacker.example", profile)).toBe(false);
  });

  test("derives a shared cookie domain only when one host is the parent of the other", () => {
    const hosted = loadServerProfileConfig({
      ...githubOAuthEnvironment,
      NODE_ENV: "production",
      SERVER_PROFILE_ORIGIN: "https://dev-api.dotrelay.dev",
      WEB_ORIGIN: "https://dev.dotrelay.dev",
      BETTER_AUTH_SECRET: "Zq7Xk2Lm9Pw4Rt6Yv8Bn3Cd5Fg1Hj0Ks",
      SERVER_PROFILE_ID: "00000000-0000-4000-8000-000000000042",
    });
    // Sibling hosts no longer share cookies implicitly: on a shared platform
    // domain the common suffix may be a public suffix.
    expect(sharedCookieDomain(hosted)).toBeUndefined();

    const sharedPlatform = loadServerProfileConfig({
      SERVER_PROFILE_ORIGIN: "https://tenant-api.platform.app",
      WEB_ORIGIN: "https://tenant-web.platform.app",
      BETTER_AUTH_SECRET: "x".repeat(32),
    });
    expect(sharedCookieDomain(sharedPlatform)).toBeUndefined();

    const parentWeb = loadServerProfileConfig({
      SERVER_PROFILE_ORIGIN: "https://api.example.com",
      WEB_ORIGIN: "https://example.com",
      BETTER_AUTH_SECRET: "x".repeat(32),
    });
    expect(sharedCookieDomain(parentWeb)).toBe("example.com");

    const parentApi = loadServerProfileConfig({
      SERVER_PROFILE_ORIGIN: "https://example.com",
      WEB_ORIGIN: "https://app.example.com",
      BETTER_AUTH_SECRET: "x".repeat(32),
    });
    expect(sharedCookieDomain(parentApi)).toBe("example.com");

    const lookalike = loadServerProfileConfig({
      SERVER_PROFILE_ORIGIN: "https://api.notexample.com",
      WEB_ORIGIN: "https://example.com",
      BETTER_AUTH_SECRET: "x".repeat(32),
    });
    expect(sharedCookieDomain(lookalike)).toBeUndefined();

    const splitDomains = loadServerProfileConfig({
      SERVER_PROFILE_ORIGIN: "https://api.example",
      WEB_ORIGIN: "https://web.other",
      BETTER_AUTH_SECRET: "Zq7Xk2Lm9Pw4Rt6Yv8Bn3Cd5Fg1Hj0Ks",
    });
    expect(sharedCookieDomain(splitDomains)).toBeUndefined();

    const sameHost = loadServerProfileConfig({
      SERVER_PROFILE_ORIGIN: "https://relay.example",
      WEB_ORIGIN: "https://relay.example",
      BETTER_AUTH_SECRET: "Zq7Xk2Lm9Pw4Rt6Yv8Bn3Cd5Fg1Hj0Ks",
    });
    expect(sharedCookieDomain(sameHost)).toBeUndefined();

    const loopback = loadServerProfileConfig({
      SERVER_PROFILE_ORIGIN: "http://localhost:3001",
      WEB_ORIGIN: "http://localhost:3000",
      BETTER_AUTH_SECRET: "Zq7Xk2Lm9Pw4Rt6Yv8Bn3Cd5Fg1Hj0Ks",
    });
    expect(sharedCookieDomain(loopback)).toBeUndefined();
  });

  test("uses an explicit COOKIE_DOMAIN that covers both hosts", () => {
    const base = {
      SERVER_PROFILE_ORIGIN: "https://dev-api.dotrelay.dev",
      WEB_ORIGIN: "https://dev.dotrelay.dev",
      BETTER_AUTH_SECRET: "x".repeat(32),
    };
    expect(
      sharedCookieDomain(
        loadServerProfileConfig({ ...base, COOKIE_DOMAIN: ".DotRelay.dev" }),
      ),
    ).toBe("dotrelay.dev");
    expect(() =>
      loadServerProfileConfig({ ...base, COOKIE_DOMAIN: "other.dev" }),
    ).toThrow("COOKIE_DOMAIN");
    expect(() =>
      loadServerProfileConfig({
        ...base,
        COOKIE_DOMAIN: "dev-api.dotrelay.dev",
      }),
    ).toThrow("COOKIE_DOMAIN");
    expect(() =>
      loadServerProfileConfig({ ...base, COOKIE_DOMAIN: "dev" }),
    ).toThrow("COOKIE_DOMAIN");
    expect(() =>
      loadServerProfileConfig({ ...base, COOKIE_DOMAIN: "dotrelay.dev/x" }),
    ).toThrow("COOKIE_DOMAIN");
    expect(
      loadServerProfileConfig({ ...base, COOKIE_DOMAIN: "" }).cookieDomain,
    ).toBeUndefined();
  });

  test("detects a request that attempts to combine cookie and bearer credentials", () => {
    expect(
      hasMixedCredentials(
        new Request("https://api.example", {
          headers: {
            Authorization: "Bearer token",
            Cookie: "better-auth.session_token=session",
          },
        }),
      ),
    ).toBe(true);
  });

  test("trusts forwarded HTTPS only behind an explicit trusted proxy", () => {
    const request = new Request("http://relay.example/api", {
      headers: { "x-forwarded-proto": "https" },
    });
    const base = {
      ...githubOAuthEnvironment,
      NODE_ENV: "production",
      SERVER_PROFILE_ORIGIN: "https://relay.example",
      BETTER_AUTH_SECRET: "Zq7Xk2Lm9Pw4Rt6Yv8Bn3Cd5Fg1Hj0Ks",
      SERVER_PROFILE_ID: "00000000-0000-4000-8000-000000000042",
    };
    expect(isSecureRequest(request, loadServerProfileConfig(base))).toBe(false);
    expect(
      isSecureRequest(
        request,
        loadServerProfileConfig({
          ...base,
          SERVER_PROFILE_TRUST_PROXY: "true",
          SERVER_PROFILE_TRUSTED_PROXIES: "192.0.2.10",
        }),
      ),
    ).toBe(true);
  });

  test("trusts the edge hop of a forwarded-HTTPS list, not a downstream append", () => {
    const trusted = loadServerProfileConfig({
      ...githubOAuthEnvironment,
      NODE_ENV: "production",
      SERVER_PROFILE_ORIGIN: "https://relay.example",
      BETTER_AUTH_SECRET: "Zq7Xk2Lm9Pw4Rt6Yv8Bn3Cd5Fg1Hj0Ks",
      SERVER_PROFILE_ID: "00000000-0000-4000-8000-000000000042",
      SERVER_PROFILE_TRUST_PROXY: "true",
      SERVER_PROFILE_TRUSTED_PROXIES: "192.0.2.10",
    });
    const untrusted = loadServerProfileConfig({
      ...githubOAuthEnvironment,
      NODE_ENV: "production",
      SERVER_PROFILE_ORIGIN: "https://relay.example",
      BETTER_AUTH_SECRET: "Zq7Xk2Lm9Pw4Rt6Yv8Bn3Cd5Fg1Hj0Ks",
      SERVER_PROFILE_ID: "00000000-0000-4000-8000-000000000042",
    });
    const forwarded = (value: string | null) =>
      new Request("http://relay.example/api", {
        headers: value === null ? {} : { "x-forwarded-proto": value },
      });
    // Cloudflare records the client's TLS protocol first; Coolify's Caddy then
    // appends the plaintext hop it proxies over. The first entry is the client
    // signal, so a trailing "http" must not veto a TLS client.
    expect(isSecureRequest(forwarded("https, http"), trusted)).toBe(true);
    expect(isSecureRequest(forwarded("https, https"), trusted)).toBe(true);
    expect(isSecureRequest(forwarded("https"), trusted)).toBe(true);
    // A client that reached the edge over plain http is not secure, even if a
    // downstream hop later used TLS.
    expect(isSecureRequest(forwarded("http, https"), trusted)).toBe(false);
    expect(isSecureRequest(forwarded("http"), trusted)).toBe(false);
    expect(isSecureRequest(forwarded(""), trusted)).toBe(false);
    expect(isSecureRequest(forwarded(null), trusted)).toBe(false);
    // Without trustProxy enabled, even a TLS client hop is not trusted.
    expect(isSecureRequest(forwarded("https"), untrusted)).toBe(false);
  });

  test("requires explicit proxy addresses for production forwarded headers", () => {
    expect(() =>
      loadServerProfileConfig({
        ...githubOAuthEnvironment,
        NODE_ENV: "production",
        SERVER_PROFILE_ORIGIN: "https://relay.example",
        BETTER_AUTH_SECRET: "Zq7Xk2Lm9Pw4Rt6Yv8Bn3Cd5Fg1Hj0Ks",
        SERVER_PROFILE_ID: "00000000-0000-4000-8000-000000000042",
        SERVER_PROFILE_TRUST_PROXY: "true",
      }),
    ).toThrow("SERVER_PROFILE_TRUSTED_PROXIES");

    expect(
      loadServerProfileConfig({
        ...githubOAuthEnvironment,
        NODE_ENV: "production",
        SERVER_PROFILE_ORIGIN: "https://relay.example",
        BETTER_AUTH_SECRET: "Zq7Xk2Lm9Pw4Rt6Yv8Bn3Cd5Fg1Hj0Ks",
        SERVER_PROFILE_ID: "00000000-0000-4000-8000-000000000042",
        SERVER_PROFILE_TRUST_PROXY: "true",
        SERVER_PROFILE_TRUSTED_PROXIES: "192.0.2.10, 2001:db8::/32",
      }).trustedProxies.join(","),
    ).toBe("192.0.2.10,2001:db8::/32");

    expect(() =>
      loadServerProfileConfig({
        SERVER_PROFILE_TRUSTED_PROXIES: "192.0.2.10/999",
      }),
    ).toThrow("invalid IP or CIDR");
  });
});
