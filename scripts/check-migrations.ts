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
  temporaryDatabase("cutover"),
  temporaryDatabase("blocked"),
] as const;
const [freshDatabase, appliedDatabase, upgradeDatabase, cutoverDatabase] =
  databases;
const admin = postgres(adminDatabase.toString(), { max: 1 });
const fresh = postgres(freshDatabase.url.toString(), { max: 1 });
const applied = postgres(appliedDatabase.url.toString(), { max: 1 });
const upgrade = postgres(upgradeDatabase.url.toString(), { max: 1 });
const cutover = postgres(cutoverDatabase.url.toString(), { max: 1 });
const cutoverBlocked = postgres(databases[4].url.toString(), { max: 1 });

const applyBaselineMigration = async (
  target: "upgrade" | "cutover" | "cutover-blocked",
  migration: string,
  executeSql: boolean,
): Promise<void> => {
  const targetDatabase =
    target === "upgrade"
      ? upgradeDatabase
      : target === "cutover"
        ? cutoverDatabase
        : databases[4];
  const environment = { DATABASE_URL: targetDatabase.url.toString() };
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

// Pre-cutover baseline: the committed migrations before the account-key
// cut-over, applied in order to a temporary database.
const preCutoverMigrations = [
  ["00000000000000_foundation", false],
  ["20260817100000_persistence", true],
  ["20260821230000_better_auth", true],
  ["20260824090000_harden_database_constraints", true],
  ["20260828120000_administration_invariants", true],
  ["20260901120000_observability_constraints", true],
  ["20260905160000_allow_duplicate_staged_digests", true],
  ["20260905170000_allow_empty_lane_ciphertext", true],
  ["20260905200000_environment_labels", true],
] as const;
const buildPreCutoverBaseline = async (
  target: "upgrade" | "cutover" | "cutover-blocked",
): Promise<void> => {
  for (const [migration, executeSql] of preCutoverMigrations)
    await applyBaselineMigration(target, migration, executeSql);
};

// Seeds the shared account tree both cutover databases need: one user with an
// activated device, a team, a project, and a protocol object. Values satisfy
// the pre-cutover CHECK constraints (48-byte device keyId, 32-byte
// x25519/ed25519 keys, 48-byte digest, pinned protocol suite).
const hexBytes = (value: number, bytes: number): string => {
  const byte = value.toString(16).padStart(2, "0");
  return Array.from({ length: bytes }, () => byte).join("");
};
const seedAccountBase = (
  sql: ReturnType<typeof postgres>,
  ids: {
    readonly serverProfileId: string;
    readonly userId: string;
    readonly deviceId: string;
    readonly teamId: string;
    readonly projectId: string;
    readonly protocolObjectId: string;
    readonly challengeProtocolObjectId: string;
  },
) =>
  sql.unsafe(`
    INSERT INTO server_profiles (id, origin)
    VALUES ('${ids.serverProfileId}', 'https://seed.example.test');
    INSERT INTO users
      (id, "serverProfileId", "authSubject", "githubSubject",
       "identityGeneration", "recoveryGeneration")
    VALUES
      ('${ids.userId}', '${ids.serverProfileId}', 'auth:seed', 'github:seed', 1, 1);
    INSERT INTO devices
      (id, "userId", lifecycle, "identityGeneration", "keyId",
       "x25519PublicKey", "ed25519PublicKey", "activatedAt")
    VALUES
      ('${ids.deviceId}', '${ids.userId}', 'ACTIVE', 1,
       '\\x${hexBytes(0, 48)}', '\\x${hexBytes(1, 32)}', '\\x${hexBytes(2, 32)}', now());
    INSERT INTO teams (id, "serverProfileId", name)
    VALUES ('${ids.teamId}', '${ids.serverProfileId}', 'seed team');
    INSERT INTO memberships (id, "teamId", "userId", "role", lifecycle, "activatedAt")
    VALUES
      ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '${ids.teamId}', '${ids.userId}',
       'OWNER', 'ACTIVE', now());
    INSERT INTO projects (id, "teamId", "githubRepositoryId", "createdByUserId")
    VALUES ('${ids.projectId}', '${ids.teamId}', 12345, '${ids.userId}');
    INSERT INTO protocol_objects (id, suite, "formatVersion", kind, "canonicalBytes", digest)
    VALUES
      ('${ids.protocolObjectId}', 'dotrelay-e2ee-v3-classical-webcrypto', 3, 1,
       '\\x${hexBytes(3, 16)}', '\\x${hexBytes(4, 48)}');
    INSERT INTO protocol_objects (id, suite, "formatVersion", kind, "canonicalBytes", digest)
    VALUES
      ('${ids.challengeProtocolObjectId}', 'dotrelay-e2ee-v3-classical-webcrypto', 3, 2,
       '\\x${hexBytes(9, 16)}', '\\x${hexBytes(10, 48)}');
  `);

// Seeds the legacy Recovery Kit state the cutover drops: an envelope, a
// recovery grant, a challenge, an attempt, and a user whose recovery was
// used. All of this lives in tables/columns the cutover deletes, so a
// disposable deployment cuts over cleanly despite it.
const seedLegacyRecoveryData = (
  sql: ReturnType<typeof postgres>,
  ids: {
    readonly userId: string;
    readonly deviceId: string;
    readonly projectId: string;
    readonly protocolObjectId: string;
    readonly challengeProtocolObjectId: string;
    readonly recoveryEnvelopeId: string;
  },
) =>
  sql.unsafe(`
    INSERT INTO recovery_envelopes
      (id, "userId", "protocolObjectId", "identityGeneration", "recoveryGeneration",
       "ciphertextHash", "ciphertextLength")
    VALUES
      ('${ids.recoveryEnvelopeId}', '${ids.userId}', '${ids.protocolObjectId}', 1, 1,
       '\\x${hexBytes(5, 48)}', 4096);
    UPDATE users SET "recoveryGeneration" = 2 WHERE id = '${ids.userId}';
    INSERT INTO recovery_grant_objects
      ("protocolObjectId", "recoveryEnvelopeId", "projectId", "grantKind", "ownerUserId")
    VALUES
      ('${ids.protocolObjectId}', '${ids.recoveryEnvelopeId}', '${ids.projectId}',
       'RECOVERY_PROJECT_KEY', '${ids.userId}');
    INSERT INTO recovery_challenge_objects
      ("protocolObjectId", "userId", "deviceId", "recoveryGeneration", "challengeHash", "expiresAt")
    VALUES
      ('${ids.challengeProtocolObjectId}', '${ids.userId}', '${ids.deviceId}', 1,
       '\\x${hexBytes(6, 48)}', now() + interval '1 hour');
    INSERT INTO recovery_attempts
      (id, "userId", "deviceId", "envelopeId", "challengeHash", succeeded)
    VALUES
      ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '${ids.userId}', '${ids.deviceId}',
       '${ids.recoveryEnvelopeId}', '\\x${hexBytes(7, 48)}', true);
  `);

// Seeds surviving-table rows holding the RECOVERY* enum members the cutover
// removes. A database that still carries these cannot cut over: the enum
// re-type fails loudly instead of silently discarding the rows.
const seedLegacySurvivingEnumRows = (
  sql: ReturnType<typeof postgres>,
  ids: {
    readonly userId: string;
    readonly deviceId: string;
    readonly recoveryEnvelopeId: string;
  },
) =>
  sql.unsafe(`
    INSERT INTO operations
      (id, "actorUserId", "actorDeviceId", kind, status, "commandDigest", "committedAt")
    VALUES
      ('88888888-8888-4888-8888-888888888808', '${ids.userId}', '${ids.deviceId}',
       'RECOVERY', 'COMMITTED', '\\x${hexBytes(8, 48)}', now());
    INSERT INTO audit_events
      (id, "operationId", kind, "actorUserId", "actorDeviceId", "entityKind", "entityId")
    VALUES
      ('99999999-9999-4999-8999-999999999909',
       '88888888-8888-4888-8888-888888888808', 'RECOVERY_COMPLETED',
       '${ids.userId}', '${ids.deviceId}', 'RECOVERY_ENVELOPE', '${ids.recoveryEnvelopeId}');
  `);

// Runs the operator guard script against a temporary database and returns its
// exit code (1 when it found legacy recovery data). The CI gate asserts the
// guard's verdict, so a regression that silences it fails the pipeline.
const runCutoverGuard = async (
  target: "cutover" | "cutover-blocked",
  acknowledge: boolean,
): Promise<number> => {
  const child = Bun.spawn(
    [
      "bun",
      "scripts/guard-legacy-recovery-cutover.ts",
      "--database",
      target === "cutover"
        ? cutoverDatabase.url.toString()
        : databases[4].url.toString(),
      ...(acknowledge ? ["--acknowledge-legacy-recovery-data"] : []),
    ],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, output] = await Promise.all([
    child.exited,
    (async () =>
      (await new Response(child.stdout).text()) +
      (await new Response(child.stderr).text()))(),
  ]);
  if (!output.trim())
    throw new Error(`cutover guard produced no output (exit ${exitCode})`);
  console.log(output.trimEnd());
  return exitCode;
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

  await buildPreCutoverBaseline("upgrade");
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

  // Cutover on a pre-production database: a disposable legacy recovery state
  // must migrate cleanly and land drift-free, and the guard must be loud
  // about it (and honor the operator's acknowledgement override).
  const cutoverIds = {
    serverProfileId: "11111111-1111-4111-8111-111111111101",
    userId: "22222222-2222-4222-8222-222222222202",
    deviceId: "33333333-3333-4333-8333-333333333303",
    teamId: "44444444-4444-4444-8444-444444444404",
    projectId: "55555555-5555-4555-8555-555555555505",
    protocolObjectId: "66666666-6666-4666-8666-666666666606",
    challengeProtocolObjectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    recoveryEnvelopeId: "77777777-7777-4777-8777-777777777707",
  } as const;
  await buildPreCutoverBaseline("cutover");
  await seedAccountBase(cutover, cutoverIds);
  await seedLegacyRecoveryData(cutover, cutoverIds);
  if ((await runCutoverGuard("cutover", false)) !== 1)
    throw new Error(
      "guard did not report legacy recovery data on the cutover database",
    );
  if ((await runCutoverGuard("cutover", true)) !== 0)
    throw new Error("guard did not honor --acknowledge-legacy-recovery-data");
  const cutoverEnvironment = {
    DATABASE_URL: cutoverDatabase.url.toString(),
  };
  await runExpected(migrationDeploy, 0, cutoverEnvironment);
  await runExpected(
    diff(["--from-config-datasource"], ["--to-schema", schema]),
    0,
    cutoverEnvironment,
  );
  const cutoverLegacyState = await cutover<{ gone: boolean }[]>`
    SELECT
      to_regclass('public.recovery_envelopes') IS NULL
        AND to_regclass('public.recovery_attempts') IS NULL
        AND to_regclass('public.recovery_challenge_objects') IS NULL
        AND to_regclass('public.recovery_grant_objects') IS NULL
        AND to_regclass('public."account_key_wrapper_objects"') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'recoveryGeneration'
        ) AS gone
  `;
  if (!cutoverLegacyState[0]?.gone)
    throw new Error(
      "cutover migration left legacy recovery tables/columns in place",
    );

  // Cutover on a database that still carries legacy RECOVERY* enum values in
  // surviving tables must fail loudly instead of silently discarding the rows.
  await buildPreCutoverBaseline("cutover-blocked");
  await seedAccountBase(cutoverBlocked, cutoverIds);
  await seedLegacyRecoveryData(cutoverBlocked, cutoverIds);
  await seedLegacySurvivingEnumRows(cutoverBlocked, cutoverIds);
  if ((await runCutoverGuard("cutover-blocked", false)) !== 1)
    throw new Error(
      "guard did not report legacy enum rows on the blocked database",
    );
  const blockedDeploy = Bun.spawn([...migrationDeploy], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: databases[4].url.toString() },
    stdout: "pipe",
    stderr: "pipe",
  });
  const blockedExitCode = await blockedDeploy.exited;
  if (blockedExitCode === 0)
    throw new Error(
      "cutover deploy succeeded on a database with legacy enum rows",
    );

  console.log(
    "✓ Prisma fresh, upgrade, applied-migration, cutover, and schema-drift checks passed",
  );
} finally {
  await Promise.allSettled([
    fresh.end({ timeout: 5 }),
    applied.end({ timeout: 5 }),
    upgrade.end({ timeout: 5 }),
    cutover.end({ timeout: 5 }),
    cutoverBlocked.end({ timeout: 5 }),
  ]);
  await Promise.allSettled(
    databases.map((database) =>
      admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(database.name)}`),
    ),
  );
  await admin.end({ timeout: 5 });
}
