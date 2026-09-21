// `bun run <script>` reads .env only in-process: it does not export the
// variables to the shell or any child process, so the `turbo run
// test:integration` that followed a bare `bun scripts/test-services.ts` ran
// without DATABASE_URL and silently skipped every integration test (a false
// green that passed CI only because CI sets the URL as a job env var). Load
// .env into this process, verify the services and the environment, then spawn
// turbo with the complete environment so the integration tasks actually run.
import { existsSync } from "node:fs";
import { join } from "node:path";

const rootDirectory = join(import.meta.dir, "..");
if (existsSync(join(rootDirectory, ".env")))
  process.loadEnvFile(join(rootDirectory, ".env"));

const databaseUrl = process.env.DATABASE_URL;
const valkeyUrl = process.env.VALKEY_URL ?? "redis://127.0.0.1:6379";
if (!databaseUrl)
  throw new Error(
    "DATABASE_URL is not set for the integration suite. Put it in the repository .env (see .env.example) so it reaches turbo's child processes.",
  );

const postgresModule = await import("postgres");
const ioredisModule = await import("ioredis");
const sql = postgresModule.default(databaseUrl, { max: 1 });
const redis = new ioredisModule.default(valkeyUrl, { lazyConnect: true });
try {
  const rows = await sql`SELECT 1 AS ready`;
  if (rows[0]?.ready !== 1)
    throw new Error("PostgreSQL readiness query returned an unexpected value");
  await redis.connect();
  if ((await redis.ping()) !== "PONG")
    throw new Error("Valkey readiness query did not return PONG");
  console.log("✓ PostgreSQL and Valkey integration services responded");
  console.log("✓ DATABASE_URL and VALKEY_URL reach the integration tasks");
} finally {
  await Promise.all([sql.end(), redis.quit()]);
}

const turbo = Bun.spawn(
  [process.execPath, "x", "turbo", "run", "test:integration"],
  {
    cwd: rootDirectory,
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exit(await turbo.exited);
