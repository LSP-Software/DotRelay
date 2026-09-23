// Pre-deploy guard for the destructive legacy-recovery cutover.
//
// `20260922000000_account_key_models` retires the pre-ADR-0009 Recovery Kit:
// it DROPS the four `recovery_*` tables (deleting any rows they hold) and
// re-types `AuditEntityKind` / `AuditEventKind` / `OperationKind` / `GrantKind`
// by removing their `RECOVERY*` members (a cast that fails if a row still
// holds one). A database that has in-flight legacy recovery data therefore
// loses that data, or has the migration fail, the moment `prisma migrate
// deploy` reaches it.
//
// Run this against a target database *before* that deploy. It is loud about
// any legacy recovery data it finds and refuses (exit 1) unless the operator
// explicitly acknowledges it. A database that has already cut over, or that
// holds no legacy data, passes silently.
//
//   bun scripts/guard-legacy-recovery-cutover.ts
//   bun scripts/guard-legacy-recovery-cutover.ts --database <DATABASE_URL>
//   bun scripts/guard-legacy-recovery-cutover.ts --acknowledge-legacy-recovery-data
//
// See docs/adr/0011-legacy-recovery-cutover-is-destructive-and-guarded.md.

import postgres from "postgres";

const args = process.argv.slice(2);
const acknowledge = args.includes("--acknowledge-legacy-recovery-data");
const databaseFlagIndex = args.indexOf("--database");
const databaseUrl: string =
  databaseFlagIndex >= 0
    ? (args[databaseFlagIndex + 1] ?? "")
    : (process.env.DATABASE_URL ??
      "postgresql://dotrelay:dotrelay@127.0.0.1:5432/dotrelay");
if (!databaseUrl) {
  console.error("--database requires a connection string");
  process.exit(2);
}

const url = new URL(databaseUrl);

// The tables the cutover drops, and the legacy enum values it removes. These
// are a fixed, trusted list — never user input — so the identifiers below are
// safe to splice into sql.unsafe() strings.
const droppedTables = [
  "recovery_envelopes",
  "recovery_attempts",
  "recovery_challenge_objects",
  "recovery_grant_objects",
] as const;
const legacyValueProbes: readonly {
  readonly table: string;
  readonly predicate: string;
  readonly label: string;
}[] = [
  {
    table: "operations",
    predicate: `"kind" IN ('RECOVERY')`,
    label: "operations.kind = RECOVERY",
  },
  {
    table: "audit_events",
    predicate: `"kind" IN ('RECOVERY_COMPLETED') OR "entityKind" IN ('RECOVERY_ENVELOPE')`,
    label: "audit_events carrying RECOVERY_COMPLETED / RECOVERY_ENVELOPE",
  },
  {
    table: "grant_objects",
    predicate: `"grantKind" IN ('RECOVERY_PROJECT_KEY', 'RECOVERY_USER_VALUE_KEY')`,
    label: "grant_objects with a RECOVERY_* grant kind",
  },
];

const tableExists = async (
  sql: ReturnType<typeof postgres>,
  table: string,
): Promise<boolean> => {
  const [row] = await sql.unsafe<{ present: boolean }[]>(
    `SELECT to_regclass('public."${table}"') IS NOT NULL AS "present"`,
  );
  return row?.present ?? false;
};

const countWhere = async (
  sql: ReturnType<typeof postgres>,
  table: string,
  predicate?: string,
): Promise<number> => {
  const where = predicate ? ` WHERE ${predicate}` : "";
  const [row] = await sql.unsafe<{ n: number }[]>(
    `SELECT count(*)::int AS "n" FROM "public"."${table}"${where}`,
  );
  return row?.n ?? 0;
};

const main = async () => {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    // The maintenance database cannot hold DotRelay tables; nothing to guard.
    if (url.pathname === "/postgres") {
      console.log("• maintenance database: no DotRelay schema to check");
      return;
    }
    if (await tableExists(sql, "account_key_wrapper_objects")) {
      console.log(
        "• legacy-recovery cutover already applied (account_key tables present)",
      );
      return;
    }
    const findings: string[] = [];
    for (const table of droppedTables) {
      if (!(await tableExists(sql, table))) continue;
      const rows = await countWhere(sql, table);
      if (rows > 0)
        findings.push(`table ${table}: ${rows} row(s) would be deleted`);
    }
    for (const probe of legacyValueProbes) {
      if (!(await tableExists(sql, probe.table))) continue;
      const rows = await countWhere(sql, probe.table, probe.predicate);
      if (rows > 0)
        findings.push(
          `${probe.label}: ${rows} row(s) would fail the enum re-type`,
        );
    }
    // The cutover also drops users.recoveryGeneration; a value above the
    // default of 1 means recovery was used on that user.
    if (await tableExists(sql, "users")) {
      const users = await countWhere(sql, "users", `"recoveryGeneration" > 1`);
      if (users > 0)
        findings.push(
          `users with recoveryGeneration > 1: ${users} (column is dropped)`,
        );
    }
    if (findings.length === 0) {
      console.log(
        "• no legacy recovery data found; the cutover can run against this database",
      );
      return;
    }
    console.error(
      [
        "✗ LEGACY RECOVERY DATA PRESENT — the cutover will destroy it:",
        ...findings.map((finding) => `    - ${finding}`),
        "",
        "The migration 20260922000000_account_key_models is destructive: it drops",
        "the recovery_* tables and re-types four enums by removing their RECOVERY*",
        "members. Do not run `prisma migrate deploy` against this database until",
        "this data is exported or the operator has decided it is disposable.",
        acknowledge
          ? ""
          : "Pass --acknowledge-legacy-recovery-data to override this guard.",
      ].join("\n"),
    );
    process.exitCode = acknowledge ? 0 : 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
};

void main();
