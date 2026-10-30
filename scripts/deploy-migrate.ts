import postgres from "postgres";

// Operator-only maintenance process, never imported by API startup. Writers
// must be stopped externally; this lock serializes maintenance processes.
const url = process.env.DATABASE_URL;
if (
  !url ||
  process.env.DOTRELAY_WRITERS_STOPPED !== "true" ||
  !process.env.BACKUP_ARCHIVE
)
  throw new Error(
    "DATABASE_URL, BACKUP_ARCHIVE and DOTRELAY_WRITERS_STOPPED=true are required",
  );
const sql = postgres(url, { max: 1, onnotice: () => undefined });
const run = async (command: string[]) => {
  const child = Bun.spawn(command, {
    stdout: "ignore",
    stderr: "ignore",
    env: process.env,
  });
  if ((await child.exited) !== 0)
    throw new Error(
      "Maintenance step failed; keep writers stopped. Do not automatically retry, resolve migrations, or roll back the schema.",
    );
};
try {
  const [lock] = await sql`SELECT pg_try_advisory_lock(107733261, 1) AS locked`;
  if (!lock?.locked)
    throw new Error("Another maintenance process holds the deployment lock");
  // Back up even the legacy state before inspecting its destructive cutover.
  await run([
    "python3",
    "ops/postgres.py",
    "backup",
    process.env.BACKUP_ARCHIVE,
  ]);
  await run([process.execPath, "scripts/guard-legacy-recovery-cutover.ts"]);
  // Use the installed locked CLI; never let bunx download a replacement.
  await run([
    process.execPath,
    "node_modules/prisma/build/index.js",
    "migrate",
    "deploy",
    "--config",
    "packages/database/prisma.config.ts",
  ]);
  console.log("Migrations completed; verify readiness before enabling traffic");
} catch {
  console.error(
    "Deployment migration failed; keep all writers stopped. Preserve the backup and failed database for investigation.",
  );
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
