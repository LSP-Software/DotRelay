import { expect, test } from "bun:test";

const read = (path: string) => Bun.file(path).text();

test("hosted API start migrates first and starts the API only if that succeeds", async () => {
  const start = await read("scripts/railpack-start.sh");
  expect(start).toContain(
    "sh -c 'bun scripts/hosted-migrate.ts && exec sh scripts/api-entrypoint.sh'",
  );
  const migrate = await read("scripts/hosted-migrate.ts");
  // Lock, then the guard with no override, then the installed Prisma CLI.
  const lock = migrate.indexOf("pg_advisory_lock(107733261, 1)");
  const guard = migrate.indexOf("scripts/guard-legacy-recovery-cutover.ts");
  const prisma = migrate.indexOf('"migrate",\n        "deploy"');
  expect(lock).toBeGreaterThan(-1);
  expect(guard).toBeGreaterThan(lock);
  expect(prisma).toBeGreaterThan(guard);
  expect(migrate).not.toContain("--acknowledge-legacy-recovery-data");
  expect(migrate).not.toMatch(/migrate resolve|--rolled-back|--applied/);
});

test("the self-hosted image never migrates at start", async () => {
  const entrypoint = await read("scripts/api-entrypoint.sh");
  const dockerfile = await read("apps/api/Dockerfile");
  expect(entrypoint).not.toContain("migrate");
  expect(dockerfile).not.toContain("hosted-migrate");
});

test("hosted deploys need no manual migration receipt", async () => {
  for (const workflow of [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
  ])
    expect(await read(workflow)).not.toContain("MIGRATED_COMMIT_SHA");
  // The independent security review still gates production.
  expect(await read(".github/workflows/release.yml")).toContain(
    "SECURITY_REVIEW_APPROVED_SHA",
  );
});
