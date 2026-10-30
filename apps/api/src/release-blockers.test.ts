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

test("hosted Project archive/restore has credentialed JSON/idempotency CORS", async () => {
  const config = loadServerProfileConfig({
    WEB_ORIGIN: "https://app.example",
    SERVER_PROFILE_ORIGIN: "https://api.example",
  });
  const app = createApi({
    profile: config,
    database: {} as never,
    auth: createInMemoryAuth(config),
  });
  const response = await app.request(
    `${config.origin}/api/v1/projects/11111111-1111-4111-8111-111111111111/lifecycle`,
    {
      method: "OPTIONS",
      headers: {
        Origin: config.webOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "content-type,idempotency-key,x-dotrelay-device-id",
      },
    },
  );
  expect(response.status).toBe(204);
  expect(response.headers.get("access-control-allow-origin")).toBe(
    config.webOrigin,
  );
  expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  expect(
    response.headers.get("access-control-allow-headers")?.toLowerCase(),
  ).toContain("idempotency-key");
  const rejected = await app.request(
    `${config.origin}/api/v1/projects/11111111-1111-4111-8111-111111111111/lifecycle`,
    {
      method: "OPTIONS",
      headers: {
        Origin: "https://untrusted.example",
        "Access-Control-Request-Method": "POST",
      },
    },
  );
  expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
});

test("concurrent readiness probes share one underlying database query", async () => {
  let calls = 0;
  let finish: ((value: ReturnType<typeof rows>) => void) | undefined;
  const pending = new Promise<ReturnType<typeof rows>>((resolve) => {
    finish = resolve;
  });
  const database = {
    $queryRaw: async () => {
      calls++;
      return pending;
    },
  } as never;
  const first = databaseReady(database);
  const second = databaseReady(database);
  expect(calls).toBe(1);
  finish?.(rows());
  expect(await first).toBe(true);
  expect(await second).toBe(true);
});

test("browser and CLI sessions cannot request delegated OAuth credentials", async () => {
  let called = false;
  const app = createApi({
    profile,
    database: {} as never,
    auth: {
      handler: async () => {
        called = true;
        return Response.json({ accessToken: "must-not-leave-service" });
      },
    } as never,
  });
  for (const path of [
    "get-access-token",
    "refresh-token",
    "get-access-token/",
    "%67et-access-token",
  ]) {
    const response = await app.request(`/api/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: profile.origin },
      body: JSON.stringify({ accountId: "github-account" }),
    });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("must-not-leave-service");
  }
  expect(called).toBe(false);
});
