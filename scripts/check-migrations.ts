import { join } from "node:path";
import postgres from "postgres";

const root = process.cwd();
const schema = join(root, "packages/database/prisma/schema.prisma");
const migrations = join(root, "packages/database/prisma/migrations");
const config = join(root, "packages/database/prisma.config.ts");
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://dotrelay:dotrelay@127.0.0.1:5432/dotrelay";

const runExpected = async (
  command: readonly string[],
  expectedExitCode: number,
  environment: Record<string, string> = {},
): Promise<void> => {
  const child = Bun.spawn([...command], {
    cwd: root,
    env: { ...process.env, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== expectedExitCode) {
    console.error(stdout);
    console.error(stderr);
    throw new Error(
      `${command.join(" ")} exited with ${exitCode}; expected ${expectedExitCode}`,
    );
  }
};

const diff = (from: readonly string[], to: readonly string[]): string[] => [
  "bun",
  "x",
  "prisma",
  "migrate",
  "diff",
  "--config",
  config,
  ...from,
  ...to,
  "--script",
  "--exit-code",
];

const migrationDeploy = [
  "bun",
  "x",
  "prisma",
  "migrate",
  "deploy",
  "--config",
  config,
];

const mainDatabase = new URL(databaseUrl);
const adminDatabase = new URL(mainDatabase);
adminDatabase.pathname = "/postgres";
adminDatabase.search = "";
const freshDatabaseName = `dotrelay_migrate_fresh_${crypto
  .randomUUID()
  .replaceAll("-", "")}`;
const appliedDatabaseName = `dotrelay_migrate_applied_${crypto
  .randomUUID()
  .replaceAll("-", "")}`;
const quoteIdentifier = (value: string): string =>
  `"${value.replaceAll('"', '""')}"`;
const freshDatabase = new URL(mainDatabase);
freshDatabase.pathname = `/${freshDatabaseName}`;
freshDatabase.search = "";
const appliedDatabase = new URL(mainDatabase);
appliedDatabase.pathname = `/${appliedDatabaseName}`;
appliedDatabase.search = "";
const admin = postgres(adminDatabase.toString(), { max: 1 });
const fresh = postgres(freshDatabase.toString(), { max: 1 });
const applied = postgres(appliedDatabase.toString(), { max: 1 });

try {
  await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(freshDatabaseName)}`);
  await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(appliedDatabaseName)}`);
  await runExpected(
    [
      "bun",
      "x",
      "prisma",
      "migrate",
      "diff",
      "--config",
      config,
      "--from-empty",
      "--to-schema",
      schema,
      "--script",
    ],
    0,
  );

  await runExpected(
    diff(["--from-config-datasource"], ["--to-schema", schema]),
    2,
    { DATABASE_URL: freshDatabase.toString() },
  );

  await runExpected(migrationDeploy, 0, {
    DATABASE_URL: appliedDatabase.toString(),
  });
  await runExpected(
    diff(["--from-config-datasource"], ["--to-schema", schema]),
    0,
    { DATABASE_URL: appliedDatabase.toString() },
  );
  await runExpected(
    diff(["--from-config-datasource"], ["--to-migrations", migrations]),
    0,
    { DATABASE_URL: appliedDatabase.toString() },
  );

  await applied.unsafe(
    'CREATE TABLE "dotrelay_schema_drift_probe" ("id" integer NOT NULL)',
  );
  await runExpected(
    diff(["--from-config-datasource"], ["--to-schema", schema]),
    2,
    { DATABASE_URL: appliedDatabase.toString() },
  );
  await applied.unsafe('DROP TABLE "dotrelay_schema_drift_probe"');
  console.log(
    "✓ Prisma fresh, applied-migration, and schema-drift checks passed",
  );
} finally {
  await fresh.end({ timeout: 5 });
  await applied.end({ timeout: 5 });
  await admin.unsafe(
    `DROP DATABASE IF EXISTS ${quoteIdentifier(freshDatabaseName)}`,
  );
  await admin.unsafe(
    `DROP DATABASE IF EXISTS ${quoteIdentifier(appliedDatabaseName)}`,
  );
  await admin.end({ timeout: 5 });
}
