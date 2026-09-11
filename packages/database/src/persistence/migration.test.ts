import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const migrationUrl = new URL(
  "../../prisma/migrations/20260817100000_persistence/migration.sql",
  import.meta.url,
);
const betterAuthMigrationUrl = new URL(
  "../../prisma/migrations/20260821230000_better_auth/migration.sql",
  import.meta.url,
);
// The harden migration repairs the head-validation trigger introduced by the
// persistence projection, so it must be applied for a faithful constraint set.
const hardenMigrationUrl = new URL(
  "../../prisma/migrations/20260824090000_harden_database_constraints/migration.sql",
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

  test("keeps revisions_parent_shape_check in force for orphan manifest updates", async () => {
    const childSource = `
      import { readFile } from "node:fs/promises";
      import { PGlite } from "@electric-sql/pglite";

      const database = new PGlite();
      try {
        for (const path of [
          process.argv[1],
          process.argv[2],
          process.argv[3],
        ]) {
          await database.exec(await readFile(path, "utf8"));
        }

        const scaffold = [
          "INSERT INTO server_profiles (id, origin) VALUES ('11111111-1111-4111-8111-111111111111', 'https://shape-check.example.test')",
          "INSERT INTO users (id, \\"serverProfileId\\", \\"authSubject\\", \\"githubSubject\\") VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'auth:shape-check', 'github:shape-check')",
          // The deferred team-owner trigger commits with its Team, so both rows move together.
          "INSERT INTO teams (id, \\"serverProfileId\\", name) VALUES ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111', 'Shape Team'); INSERT INTO memberships (id, \\"teamId\\", \\"userId\\", role, lifecycle, \\"activatedAt\\") VALUES ('99999999-9999-4999-8999-999999999999', '44444444-4444-4444-8444-444444444444', '22222222-2222-4222-8222-222222222222', 'OWNER', 'ACTIVE', CURRENT_TIMESTAMP)",
          "INSERT INTO projects (id, \\"teamId\\", \\"githubRepositoryId\\", \\"createdByUserId\\") VALUES ('55555555-5555-4555-8555-555555555555', '44444444-4444-4444-8444-444444444444', 1, '22222222-2222-4222-8222-222222222222')",
          "INSERT INTO environments (id, \\"projectId\\", \\"createdByUserId\\") VALUES ('66666666-6666-4666-8666-666666666666', '55555555-5555-4555-8555-555555555555', '22222222-2222-4222-8222-222222222222')",
          "INSERT INTO devices (id, \\"userId\\", lifecycle, \\"identityGeneration\\", \\"keyId\\", \\"x25519PublicKey\\", \\"ed25519PublicKey\\", \\"activatedAt\\") VALUES ('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', 'ACTIVE', 1, decode(repeat('00', 48), 'hex'), decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'), CURRENT_TIMESTAMP)",
          "INSERT INTO operations (id, \\"actorUserId\\", \\"actorDeviceId\\", kind, \\"commandDigest\\") VALUES ('77777777-7777-4777-8777-777777777777', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', 'REVISION_PUBLICATION', decode(repeat('00', 48), 'hex'))",
          "INSERT INTO protocol_objects (id, suite, \\"formatVersion\\", kind, \\"canonicalBytes\\", digest, \\"projectId\\", \\"environmentId\\") VALUES ('88888888-8888-4888-8888-888888888888', 'dotrelay-e2ee-v3-classical-webcrypto', 3, 16, decode('0102', 'hex'), decode(repeat('00', 48), 'hex'), '55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666')",
        ];
        for (const statement of scaffold) await database.exec(statement);

        const revision = (id, mutation, parentId, parentHash) =>
          "INSERT INTO revisions (id, \\"protocolObjectId\\", \\"operationId\\", \\"environmentId\\", \\"authorUserId\\", \\"signingDeviceId\\", \\"projectEpoch\\", \\"mutation\\", \\"authoredAtMs\\"" +
            (parentId ? ", \\"parentId\\", \\"parentHash\\"" : "") +
            ") VALUES ('" +
            id +
            "', '88888888-8888-4888-8888-888888888888', '77777777-7777-4777-8777-777777777777', '66666666-6666-4666-8666-666666666666', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', 1, '" +
            mutation +
            "', 0" +
            (parentId ? ", '" + parentId + "', " + parentHash : "") +
            ")";

        let orphanRejected = false;
        try {
          await database.exec(
            revision(
              "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              "MANIFEST_UPDATE",
              null,
              null,
            ),
          );
        } catch (error) {
          orphanRejected = String(error).includes("revisions_parent_shape_check");
        }
        if (!orphanRejected) {
          throw new Error(
            "revisions_parent_shape_check did not reject an orphan MANIFEST_UPDATE",
          );
        }
        const orphanCount = (
          await database.query("SELECT count(*) FROM revisions")
        ).rows[0]?.count;
        if (String(orphanCount) !== "0") {
          throw new Error("rejected revision row was retained");
        }

        await database.exec(
          revision(
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "GENESIS",
            null,
            null,
          ),
        );
        const revisions = (await database.query("SELECT id FROM revisions")).rows;
        if (
          revisions.length !== 1 ||
          revisions[0]?.id !== "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        ) {
          throw new Error("valid genesis revision was not recorded");
        }
      } finally {
        await database.close();
      }
      console.log("parent-shape-ok");
    `;
    const child = Bun.spawn(
      [
        "node",
        "--input-type=module",
        "-e",
        childSource,
        fileURLToPath(migrationUrl),
        fileURLToPath(betterAuthMigrationUrl),
        fileURLToPath(hardenMigrationUrl),
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
    expect(stdout.trim()).toBe("parent-shape-ok");
    expect(stderr).not.toMatch(/error/i);
  });
});
