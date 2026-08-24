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
const quoteIdentifier = (value: string): string =>
  `"${value.replaceAll('"', '""')}"`;
const temporaryDatabase = (purpose: string) => {
  const name = `dotrelay_migrate_${purpose}_${crypto
    .randomUUID()
    .replaceAll("-", "")}`;
  const url = new URL(mainDatabase);
  url.pathname = `/${name}`;
  return { name, url } as const;
};
const databases = [
  temporaryDatabase("fresh"),
  temporaryDatabase("applied"),
  temporaryDatabase("upgrade"),
] as const;
const [freshDatabase, appliedDatabase, upgradeDatabase] = databases;
const admin = postgres(adminDatabase.toString(), { max: 1 });
const fresh = postgres(freshDatabase.url.toString(), { max: 1 });
const applied = postgres(appliedDatabase.url.toString(), { max: 1 });
const upgrade = postgres(upgradeDatabase.url.toString(), { max: 1 });

const applyBaselineMigration = async (
  migration: string,
  executeSql: boolean,
): Promise<void> => {
  const environment = { DATABASE_URL: upgradeDatabase.url.toString() };
  if (executeSql)
    await runExpected(
      [
        "bun",
        "x",
        "prisma",
        "db",
        "execute",
        "--config",
        config,
        "--file",
        join(migrations, migration, "migration.sql"),
      ],
      0,
      environment,
    );
  await runExpected(
    [
      "bun",
      "x",
      "prisma",
      "migrate",
      "resolve",
      "--config",
      config,
      "--applied",
      migration,
    ],
    0,
    environment,
  );
};

try {
  for (const database of databases)
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(database.name)}`);
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
    { DATABASE_URL: freshDatabase.url.toString() },
  );

  await runExpected(migrationDeploy, 0, {
    DATABASE_URL: appliedDatabase.url.toString(),
  });
  await runExpected(
    diff(["--from-config-datasource"], ["--to-schema", schema]),
    0,
    { DATABASE_URL: appliedDatabase.url.toString() },
  );
  await runExpected(
    diff(["--from-config-datasource"], ["--to-migrations", migrations]),
    0,
    { DATABASE_URL: appliedDatabase.url.toString() },
  );

  await applied.unsafe(
    'CREATE TABLE "dotrelay_schema_drift_probe" ("id" integer NOT NULL)',
  );
  await runExpected(
    diff(["--from-config-datasource"], ["--to-schema", schema]),
    2,
    { DATABASE_URL: appliedDatabase.url.toString() },
  );
  await applied.unsafe('DROP TABLE "dotrelay_schema_drift_probe"');

  await applyBaselineMigration("00000000000000_foundation", false);
  await applyBaselineMigration("20260817100000_persistence", true);
  await applyBaselineMigration("20260821230000_better_auth", true);
  await upgrade`
    INSERT INTO auth_users
      (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES
      ('upgrade-user', 'Upgrade User', 'upgrade@example.test', false, now(), now())
  `;
  await upgrade`
    INSERT INTO auth_device_codes
      (id, "deviceCode", "userCode", "userId", "expiresAt", status)
    VALUES
      ('upgrade-code', 'device-code', 'user-code', 'upgrade-user', now() + interval '1 hour', 'pending')
  `;
  const upgradeEnvironment = {
    DATABASE_URL: upgradeDatabase.url.toString(),
  };
  await runExpected(migrationDeploy, 0, upgradeEnvironment);
  const upgradedDeviceCode = await upgrade<{ userId: string; email: string }[]>`
    SELECT codes."userId", users.email
    FROM auth_device_codes codes
    JOIN auth_users users ON users.id = codes."userId"
    WHERE codes.id = 'upgrade-code'
  `;
  if (
    upgradedDeviceCode[0]?.userId !== "upgrade-user" ||
    upgradedDeviceCode[0]?.email !== "upgrade@example.test"
  )
    throw new Error("upgrade migration did not preserve base-state rows");
  await runExpected(
    diff(["--from-config-datasource"], ["--to-schema", schema]),
    0,
    upgradeEnvironment,
  );
  console.log(
    "✓ Prisma fresh, upgrade, applied-migration, and schema-drift checks passed",
  );
} finally {
  await Promise.allSettled([
    fresh.end({ timeout: 5 }),
    applied.end({ timeout: 5 }),
    upgrade.end({ timeout: 5 }),
  ]);
  await Promise.allSettled(
    databases.map((database) =>
      admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(database.name)}`),
    ),
  );
  await admin.end({ timeout: 5 });
}
