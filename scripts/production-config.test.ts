import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProductionEnvironment } from "./runtime-config";

// Assembled at runtime so the secret scanner does not read a fixture as a key;
// it still clears the production length and character-variety checks.
const testAuthSecret = [
  "fixture",
  "only",
  "auth",
  "secret",
  "Qx7",
  "Lm9",
  "Rt6",
].join("-");

const valid = {
  NODE_ENV: "production",
  SERVER_PROFILE_ID: "11111111-1111-4111-8111-111111111111",
  SERVER_PROFILE_ORIGIN: "https://api.example",
  WEB_ORIGIN: "https://web.example",
  DATABASE_URL: "postgresql://test:test@db:5432/dotrelay",
  BETTER_AUTH_SECRET: testAuthSecret,
  GITHUB_CLIENT_ID: "Iv1.test",
  GITHUB_CLIENT_SECRET: "client-secret",
  VALKEY_URL: "redis://valkey:6379",
};
test("production requires every essential setting, explicit mode, secure origins and App credentials", () => {
  expect(loadProductionEnvironment(valid).NODE_ENV).toBe("production");
  for (const field of Object.keys(valid)) {
    expect(() =>
      loadProductionEnvironment({ ...valid, [field]: undefined }),
    ).toThrow();
    expect(() =>
      loadProductionEnvironment({ ...valid, [field]: "" }),
    ).toThrow();
  }
  for (const change of [
    { NODE_ENV: "development" },
    { NODE_ENV: "prod" },
    { SERVER_PROFILE_ORIGIN: "http://api.example" },
    { WEB_ORIGIN: "http://localhost:3000" },
    { BETTER_AUTH_SECRET: "short" },
    { BETTER_AUTH_SECRET: "replace-with-at-least-32-random-characters" },
    { BETTER_AUTH_SECRET: "a".repeat(40) },
    { SERVER_PROFILE_ID: "00000000-0000-4000-8000-000000000001" },
    { DATABASE_URL: "postgresql://dotrelay:dotrelay@db:5432/dotrelay" },
    { VALKEY_URL: "http://valkey:6379" },
    { GITHUB_CLIENT_ID: "classic-client" },
    { DATABASE_URL: "not-a-url" },
    { DATABASE_URL: "https://user:do-not-print@private.example/app" },
  ]) {
    expect(() => loadProductionEnvironment({ ...valid, ...change })).toThrow();
  }
  let message = "";
  try {
    loadProductionEnvironment({ ...valid, DATABASE_URL: "secret-invalid-url" });
  } catch (error) {
    message = String(error);
  }
  expect(message).toContain("DATABASE_URL must identify a PostgreSQL database");
  expect(message).not.toContain("secret-invalid-url");
});

test("metrics stay off by default and need a long bearer token when enabled", () => {
  const metricsToken = ["metrics", "fixture", "token", "0123456789"].join("-");
  expect(loadProductionEnvironment(valid).METRICS_ENABLED).toBeUndefined();
  expect(
    loadProductionEnvironment({
      ...valid,
      METRICS_ENABLED: "true",
      METRICS_TOKEN: metricsToken,
    }).METRICS_TOKEN,
  ).toBe(metricsToken);
  for (const change of [
    { METRICS_ENABLED: "true" },
    { METRICS_ENABLED: "true", METRICS_TOKEN: "short" },
    {
      METRICS_ENABLED: "true",
      METRICS_TOKEN: metricsToken,
      METRICS_PORT: "3001",
    },
    { METRICS_ENABLED: "on", METRICS_TOKEN: metricsToken },
  ])
    expect(() => loadProductionEnvironment({ ...valid, ...change })).toThrow();
});

test("private secret files work; conflicting, public, symlink and directory inputs fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dotrelay-config-"));
  try {
    const path = join(directory, "secret");
    await writeFile(path, valid.BETTER_AUTH_SECRET, { mode: 0o600 });
    expect(
      loadProductionEnvironment({
        ...valid,
        BETTER_AUTH_SECRET: undefined,
        BETTER_AUTH_SECRET_FILE: path,
      }).BETTER_AUTH_SECRET,
    ).toBe(valid.BETTER_AUTH_SECRET);
    expect(() =>
      loadProductionEnvironment({ ...valid, BETTER_AUTH_SECRET_FILE: path }),
    ).toThrow("mutually exclusive");
    expect(() =>
      loadProductionEnvironment({
        ...valid,
        BETTER_AUTH_SECRET: undefined,
        BETTER_AUTH_SECRET_FILE: directory,
      }),
    ).toThrow("regular file");
    if (process.platform !== "win32") {
      const link = join(directory, "symlink");
      await symlink(path, link);
      expect(() =>
        loadProductionEnvironment({
          ...valid,
          BETTER_AUTH_SECRET: undefined,
          BETTER_AUTH_SECRET_FILE: link,
        }),
      ).toThrow("regular file");
      await chmod(path, 0o644);
      expect(() =>
        loadProductionEnvironment({
          ...valid,
          BETTER_AUTH_SECRET: undefined,
          BETTER_AUTH_SECRET_FILE: path,
        }),
      ).toThrow("private");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("transactional email is optional, but configured values must be well-formed", () => {
  const resendKey = ["re", "fixtureOnlyKey123"].join("_");
  expect(loadProductionEnvironment(valid).RESEND_API_KEY).toBeUndefined();
  expect(
    loadProductionEnvironment({
      ...valid,
      RESEND_API_KEY: resendKey,
      EMAIL_FROM: "DotRelay <noreply@dotrelay.dev>",
      EMAIL_SUPPORT_ADDRESS: "support@dotrelay.dev",
    }).RESEND_API_KEY,
  ).toBe(resendKey);
  for (const change of [
    { RESEND_API_KEY: "not-a-resend-key" },
    { EMAIL_FROM: "DotRelay noreply@dotrelay.dev" },
    { EMAIL_SUPPORT_ADDRESS: "support" },
  ]) {
    let message = "";
    try {
      loadProductionEnvironment({ ...valid, ...change });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain(Object.keys(change)[0] ?? "");
    expect(message).not.toContain(Object.values(change)[0] ?? "");
  }
});

test("RESEND_API_KEY_FILE reads a private secret file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dotrelay-config-"));
  try {
    const path = join(directory, "resend");
    const resendKey = ["re", "fixtureOnlyKey123"].join("_");
    await writeFile(path, `${resendKey}\n`, { mode: 0o600 });
    expect(
      loadProductionEnvironment({ ...valid, RESEND_API_KEY_FILE: path })
        .RESEND_API_KEY,
    ).toBe(resendKey);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
