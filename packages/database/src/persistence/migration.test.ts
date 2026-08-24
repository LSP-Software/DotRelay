import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const migrationUrl = new URL(
  "../../prisma/migrations/20260817100000_persistence/migration.sql",
  import.meta.url,
);

describe("persistence migration boundary", () => {
  test("applies the typed projection and protects immutable protocol rows", async () => {
    const childSource = `
      import { readFile } from "node:fs/promises";
      import { PGlite } from "@electric-sql/pglite";

      const database = new PGlite();
      try {
        await database.exec(await readFile(process.argv[1], "utf8"));

        const tables = await database.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('protocol_objects', 'revisions', 'revision_lane_commitments', 'audit_events', 'security_request_logs')",
        );
        if (JSON.stringify(tables.rows.map((row) => row.table_name).sort()) !== JSON.stringify([
          "audit_events",
          "protocol_objects",
          "revision_lane_commitments",
          "revisions",
          "security_request_logs",
        ])) {
          throw new Error("migration omitted a required typed table");
        }

        const jsonColumns = await database.query(
          "SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND data_type IN ('json', 'jsonb')",
        );
        if (jsonColumns.rows.length !== 0) {
          throw new Error("migration introduced a JSON column");
        }

        await database.exec(
          "INSERT INTO protocol_objects (id, suite, \\"formatVersion\\", kind, \\"canonicalBytes\\", digest) VALUES ('00000000-0000-0000-0000-000000000001', 'dotrelay-e2ee-v3-classical-webcrypto', 3, 1, '\\\\x0102', decode(repeat('00', 48), 'hex'))",
        );
        let immutable = false;
        try {
          await database.exec(
            "UPDATE protocol_objects SET \\"canonicalBytes\\" = '\\\\x03' WHERE id = '00000000-0000-0000-0000-000000000001'",
          );
        } catch (error) {
          immutable = String(error).includes("immutable DotRelay row");
        }
        if (!immutable) {
          throw new Error("immutable protocol trigger did not reject the update");
        }
      } finally {
        await database.close();
      }
      console.log("migration-ok");
    `;
    const child = Bun.spawn(
      [
        "node",
        "--input-type=module",
        "-e",
        childSource,
        fileURLToPath(migrationUrl),
      ],
      {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("migration-ok");
    expect(stderr).not.toMatch(/error/i);
  });
});
