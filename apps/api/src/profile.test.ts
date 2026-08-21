import { describe, expect, test } from "bun:test";
import {
  ensureServerProfile,
  hasMixedCredentials,
  isAllowedOrigin,
  isSecureRequest,
  loadServerProfileConfig,
  normalizeOrigin,
} from "./profile";

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

  test("accepts lower operational quotas but never raises protocol ceilings", () => {
    const profile = loadServerProfileConfig({
      NODE_ENV: "production",
      SERVER_PROFILE_ORIGIN: "https://relay.example",
      BETTER_AUTH_SECRET: "x".repeat(32),
      ADMIN_BODY_BYTES: "1024",
      SERVER_PROFILE_ID: "00000000-0000-4000-8000-000000000042",
    });
    expect(profile.origin).toBe("https://relay.example");
    expect(profile.limits.adminBodyBytes).toBe(1024);
    expect(() =>
      loadServerProfileConfig({
        NODE_ENV: "production",
        SERVER_PROFILE_ORIGIN: "https://relay.example",
        BETTER_AUTH_SECRET: "x".repeat(32),
        ADMIN_BODY_BYTES: "300000",
        SERVER_PROFILE_ID: "00000000-0000-4000-8000-000000000042",
      }),
    ).toThrow("protocol ceiling");
  });

  test("accepts only the configured browser or Server Profile origin", () => {
    const profile = loadServerProfileConfig({
      WEB_ORIGIN: "https://app.example",
      SERVER_PROFILE_ORIGIN: "https://api.example",
      BETTER_AUTH_SECRET: "x".repeat(32),
    });
    expect(isAllowedOrigin("https://app.example", profile)).toBe(true);
    expect(isAllowedOrigin("https://api.example", profile)).toBe(true);
    expect(isAllowedOrigin("https://attacker.example", profile)).toBe(false);
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
      NODE_ENV: "production",
      SERVER_PROFILE_ORIGIN: "https://relay.example",
      BETTER_AUTH_SECRET: "x".repeat(32),
      SERVER_PROFILE_ID: "00000000-0000-4000-8000-000000000042",
    };
    expect(isSecureRequest(request, loadServerProfileConfig(base))).toBe(false);
    expect(
      isSecureRequest(
        request,
        loadServerProfileConfig({
          ...base,
          SERVER_PROFILE_TRUST_PROXY: "true",
        }),
      ),
    ).toBe(true);
  });

  test("fails closed on a persisted origin change unless explicitly rebound", async () => {
    const updates: unknown[] = [];
    const database = {
      serverProfile: {
        findUnique: async () => ({ origin: "https://old.example" }),
        update: async (input: unknown) => updates.push(input),
        create: async () => undefined,
      },
    } as never;
    const environment = {
      SERVER_PROFILE_ORIGIN: "https://new.example",
      BETTER_AUTH_SECRET: "x".repeat(32),
    };
    const profile = loadServerProfileConfig(environment);
    await expect(ensureServerProfile(database, profile)).rejects.toThrow(
      "SERVER_PROFILE_REBIND=true",
    );
    await ensureServerProfile(
      database,
      loadServerProfileConfig({
        ...environment,
        SERVER_PROFILE_REBIND: "true",
      }),
    );
    expect(updates).toHaveLength(1);
  });
});
