import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProductionEnvironment } from "./runtime-config";

const valid = {
  NODE_ENV: "production",
  SERVER_PROFILE_ID: "11111111-1111-4111-8111-111111111111",
  SERVER_PROFILE_ORIGIN: "https://api.example",
  WEB_ORIGIN: "https://web.example",
  DATABASE_URL: "postgresql://test:test@db:5432/dotrelay",
  BETTER_AUTH_SECRET: "a".repeat(40),
  GITHUB_CLIENT_ID: "Iv1.test",
  GITHUB_CLIENT_SECRET: "client-secret",
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
