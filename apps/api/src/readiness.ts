import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PrismaClient } from "@dotrelay/database";

const directory = resolve(
  import.meta.dir,
  "../../../packages/database/prisma/migrations",
);
const readExpectedMigrations = () =>
  readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      checksum: createHash("sha256")
        .update(readFileSync(resolve(directory, entry.name, "migration.sql")))
        .digest("hex"),
    }));
let cachedMigrations: ReturnType<typeof readExpectedMigrations> | undefined;
export const expectedMigrations = () =>
  (cachedMigrations ??= readExpectedMigrations());
const checks = new WeakMap<PrismaClient, Promise<boolean>>();

const checkDatabase = async (database: PrismaClient): Promise<boolean> => {
  try {
    const rows = await database.$queryRaw<
      Array<{
        migration_name: string;
        checksum: string;
        finished_at: Date | null;
        rolled_back_at: Date | null;
      }>
    >`SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"`;
    const applied = rows.filter((row) => row.rolled_back_at === null);
    const expected = expectedMigrations();
    return (
      applied.length === expected.length &&
      expected.every((entry) =>
        applied.some(
          (row) =>
            row.migration_name === entry.name &&
            row.checksum === entry.checksum &&
            row.finished_at !== null,
        ),
      )
    );
  } catch {
    return false;
  }
};

// Share the underlying query until it actually settles, even after callers'
// response deadlines. Slow PostgreSQL cannot accumulate probe work on the pool.
export const databaseReady = async (
  database: PrismaClient,
): Promise<boolean> => {
  let check = checks.get(database);
  if (!check) {
    check = checkDatabase(database);
    checks.set(database, check);
    const current = check;
    void current.finally(() => {
      setTimeout(() => {
        if (checks.get(database) === current) checks.delete(database);
      }, 1000).unref();
    });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      check,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 3000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
