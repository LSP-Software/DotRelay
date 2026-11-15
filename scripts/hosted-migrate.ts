import postgres from "postgres";
import { loadProductionEnvironment } from "./runtime-config";

// Hosted (Coolify) deploys apply pending migrations here, at container start,
// before the API listens: railpack-start.sh runs this and starts the API only
// if it exits 0. The self-hosted image never runs it; self-hosters use the
// backed-up scripts/deploy-migrate.ts. See docs/adr/0016-hosted-deploys-migrate-at-start.md.
//
// Steps: take the same advisory lock as deploy-migrate.ts (waiting for it, so
// two starts or a manual maintenance run cannot race), run the legacy-recovery
// guard without an override, then the installed Prisma `migrate deploy`. Any
// failure exits 1 and the API does not start. Nothing here resolves or rolls
// back a failed migration. Never print the connection string.
const lockWaitSeconds = 300;
const log = (message: string) => console.error(`[migrate] ${message}`);

const run = async (
  command: string[],
  environment: NodeJS.ProcessEnv,
): Promise<boolean> => {
  const child = Bun.spawn(command, {
    env: environment,
    stdout: "inherit",
    stderr: "inherit",
  });
  return (await child.exited) === 0;
};

let step = "configuration";
let sql: ReturnType<typeof postgres> | undefined;
try {
  // Same checks (and *_FILE secret resolution) as the API start itself.
  const environment: NodeJS.ProcessEnv = {
    ...loadProductionEnvironment(process.env),
    // No Prisma update checks or telemetry from production.
    CHECKPOINT_DISABLE: "1",
  };
  step = "database connection";
  sql = postgres(environment.DATABASE_URL!, {
    max: 1,
    max_lifetime: null,
    idle_timeout: 0,
    onnotice: () => undefined,
  });
  const connection = await sql.reserve();
  step = "deployment lock";
  log("waiting for the deployment lock");
  await connection.unsafe(`SET lock_timeout = '${lockWaitSeconds}s'`);
  await connection`SELECT pg_advisory_lock(107733261, 1)`;
  log("deployment lock held");

  step = "legacy-recovery guard";
  log("running the legacy-recovery guard");
  if (
    !(await run(
      [process.execPath, "scripts/guard-legacy-recovery-cutover.ts"],
      environment,
    ))
  )
    throw new Error();

  step = "Prisma migrations";
  log("applying pending migrations (prisma migrate deploy)");
  // Use the installed locked CLI; never let bunx download a replacement.
  if (
    !(await run(
      [
        process.execPath,
        "node_modules/prisma/build/index.js",
        "migrate",
        "deploy",
        "--config",
        "packages/database/prisma.config.ts",
      ],
      environment,
    ))
  )
    throw new Error();
  log("migrations up to date; starting the API");
} catch (error) {
  log(`FAILED at step: ${step}; the API will not start`);
  // Configuration errors carry only variable names, never values.
  if (step === "configuration" && error instanceof Error) log(error.message);
  log(
    "Do not resolve or roll back migrations automatically. Investigate the database; restore from the Coolify S3 backups if a forward repair is impossible.",
  );
  process.exitCode = 1;
} finally {
  // Ending the session releases the advisory lock.
  await sql?.end({ timeout: 5 }).catch(() => undefined);
}
