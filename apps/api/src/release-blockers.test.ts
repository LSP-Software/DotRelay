import { expect, test } from "bun:test";
import { createInMemoryAuth } from "./auth";
import { createApi, loadServerProfileConfig } from "./index";
import { databaseReady, expectedMigrations } from "./readiness";

const profile = loadServerProfileConfig({
  SERVER_PROFILE_ORIGIN: "http://localhost:39177",
  GITHUB_CLIENT_ID: "Iv1.test",
  GITHUB_CLIENT_SECRET: "test-secret",
});
test("GitHub App authorization requests no classic OAuth scopes", async () => {
  const auth = createInMemoryAuth(profile);
  (await auth.$context).rateLimit.enabled = false;
  const response = await auth.handler(
    new Request(`${profile.origin}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: profile.origin },
      body: JSON.stringify({ provider: "github", callbackURL: profile.origin }),
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { url: string };
  expect(new URL(body.url).searchParams.get("scope") ?? "").toBe("");
});

const rows = () =>
  expectedMigrations().map((migration) => ({
    migration_name: migration.name,
    checksum: migration.checksum,
    finished_at: new Date(),
    rolled_back_at: null,
  }));
test("readiness fails closed on unavailable, missing, failed, altered or newer migrations", async () => {
  const valid = rows();
  for (const history of [
    [],
    valid.slice(1),
    [...valid, { ...valid[0], migration_name: "future" }],
    valid.map((row, index) => (index ? row : { ...row, finished_at: null })),
    valid.map((row, index) => (index ? row : { ...row, checksum: "changed" })),
  ]) {
    expect(
      await databaseReady({ $queryRaw: async () => history } as never),
    ).toBe(false);
  }
  expect(
    await databaseReady({
      $queryRaw: async () => {
        throw new Error("postgres://private:secret@host");
      },
    } as never),
  ).toBe(false);
  expect(await databaseReady({ $queryRaw: async () => valid } as never)).toBe(
    true,
  );
});

test("readiness is private-detail-free, database-aware and distinct from liveness", async () => {
  const app = createApi({
    profile,
    auth: createInMemoryAuth(profile),
    database: {
      $queryRaw: async () => {
        throw new Error("secret-url");
      },
    } as never,
  });
  expect((await app.request("/health")).status).toBe(200);
  const ready = await app.request("/ready");
  expect(ready.status).toBe(503);
  expect(ready.headers.get("cache-control")).toBe("no-store");
  expect(await ready.text()).toBe('{"status":"unavailable"}');
});
