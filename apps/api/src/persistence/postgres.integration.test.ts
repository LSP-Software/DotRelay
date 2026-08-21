import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;
const migrationPath = new URL(
  "../../prisma/migrations/20260817100000_persistence/migration.sql",
  import.meta.url,
);

const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

describe("PostgreSQL persistence integration", () => {
  integrationTest(
    "applies a fresh migration and rolls back writes",
    async () => {
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      const schema = `dotrelay_test_${crypto.randomUUID().replaceAll("-", "")}`;
      const identifier = quoteIdentifier(schema);
      const client = await pool.connect();
      try {
        await client.query(`CREATE SCHEMA ${identifier}`);
        await client.query(`SET search_path TO ${identifier}`);
        const migration = (await readFile(migrationPath, "utf8")).replace(
          'CREATE SCHEMA IF NOT EXISTS "public";',
          `CREATE SCHEMA IF NOT EXISTS ${identifier};`,
        );
        await client.query(migration);

        await client.query("BEGIN");
        await client.query(
          `INSERT INTO protocol_objects
          (id, suite, "formatVersion", kind, "canonicalBytes", digest)
         VALUES
          ($1, 'dotrelay-e2ee-v3-classical-webcrypto', 3, 1, $2, $3)`,
          [crypto.randomUUID(), Buffer.from([0xa0]), Buffer.alloc(48)],
        );
        await client.query("ROLLBACK");

        const count = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM protocol_objects",
        );
        expect(count.rows[0]?.count).toBe("0");

        const protocolId = crypto.randomUUID();
        await client.query(
          `INSERT INTO protocol_objects
          (id, suite, "formatVersion", kind, "canonicalBytes", digest)
         VALUES ($1, 'dotrelay-e2ee-v3-classical-webcrypto', 3, 1, $2, $3)`,
          [protocolId, Buffer.from([0xa0]), Buffer.alloc(48, 1)],
        );
        await expect(
          client.query(
            `UPDATE protocol_objects SET "canonicalBytes" = $1 WHERE id = $2`,
            [Buffer.from([0xa1, 0x00, 0x01]), protocolId],
          ),
        ).rejects.toThrow("immutable DotRelay row");
      } finally {
        await client.query(`DROP SCHEMA IF EXISTS ${identifier} CASCADE`);
        client.release();
        await pool.end();
      }
    },
  );
});
