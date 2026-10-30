import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PrismaClient } from "@dotrelay/database";

const directory = resolve(
  import.meta.dir,
  "../../../packages/database/prisma/migrations",
);
export const expectedMigrations = () =>
  readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      checksum: createHash("sha256")
        .update(readFileSync(resolve(directory, entry.name, "migration.sql")))
        .digest("hex"),
    }));

// Exact migration history is required; newer schemas must not be served by
// an older API. No schema details or connection failures leave this boundary.
export const databaseReady = async (
  database: PrismaClient,
): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
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
      })(),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 3000);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
};
