import { describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publicationBaselineInputPath,
  publicationBaselinePath,
  readPublicationBaseline,
  writePublicationBaseline,
} from "./baseline-store";

const environmentId = "11111111-1111-4111-8111-111111111111";
const revision = (n: number) => `22222222-2222-4222-8222-22222222222${n}`;
const hash = (c: string) => c.repeat(96);

describe("publication baseline store", () => {
  test("replaces the entry for a relative input path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dotrelay-baseline-"));
    await writePublicationBaseline(dir, {
      environmentId,
      inputPath: ".env",
      revisionId: revision(1),
      headHash: hash("a"),
    });
    await writePublicationBaseline(dir, {
      environmentId,
      inputPath: ".env",
      revisionId: revision(2),
      headHash: hash("b"),
    });
    const stored = JSON.parse(
      await readFile(publicationBaselinePath(dir), "utf8"),
    );
    expect(stored.entries).toHaveLength(1);
    expect(
      (await readPublicationBaseline(dir, environmentId, ".env"))?.revisionId,
    ).toBe(revision(2));
  });

  test("reads the last of existing duplicate entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dotrelay-baseline-"));
    const inputPath = publicationBaselineInputPath(".env");
    await writeFile(
      publicationBaselinePath(dir),
      JSON.stringify({
        version: 1,
        entries: [
          {
            environmentId,
            inputPath,
            revisionId: revision(1),
            headHash: hash("a"),
          },
          {
            environmentId,
            inputPath,
            revisionId: revision(2),
            headHash: hash("b"),
          },
        ],
      }),
    );
    expect(
      (await readPublicationBaseline(dir, environmentId, ".env"))?.revisionId,
    ).toBe(revision(2));
  });

  test("keeps every entry when processes record baselines concurrently", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dotrelay-baseline-"));
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        writePublicationBaseline(dir, {
          environmentId,
          inputPath: join(dir, `file-${index}.env`),
          revisionId: revision(1),
          headHash: hash("a"),
        }),
      ),
    );
    const stored = JSON.parse(
      await readFile(publicationBaselinePath(dir), "utf8"),
    );
    expect(stored.entries).toHaveLength(12);
  });

  test("breaks a lock left behind by a process that died", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dotrelay-baseline-"));
    const lock = `${publicationBaselinePath(dir)}.lock`;
    await writeFile(lock, "999999\n");
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    await writePublicationBaseline(dir, {
      environmentId,
      inputPath: join(dir, ".env"),
      revisionId: revision(1),
      headHash: hash("a"),
    });
    expect(
      (await readPublicationBaseline(dir, environmentId, join(dir, ".env")))
        ?.revisionId,
    ).toBe(revision(1));
  });

  test("finds a baseline through a symlinked path to the same file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dotrelay-baseline-"));
    const real = join(dir, "real.env");
    const link = join(dir, "link.env");
    await writeFile(real, "A=1\n");
    await symlink(real, link);
    await writePublicationBaseline(dir, {
      environmentId,
      inputPath: real,
      revisionId: revision(3),
      headHash: hash("c"),
    });
    expect(
      (await readPublicationBaseline(dir, environmentId, link))?.revisionId,
    ).toBe(revision(3));
  });

  test("records whether a baseline is only a fallback anchor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dotrelay-baseline-"));
    await writePublicationBaseline(dir, {
      environmentId,
      inputPath: join(dir, ".env"),
      revisionId: revision(1),
      headHash: hash("a"),
      origin: "fallback",
    });
    expect(
      await readPublicationBaseline(dir, environmentId, join(dir, ".env")),
    ).toMatchObject({ origin: "fallback" });
    await writePublicationBaseline(dir, {
      environmentId,
      inputPath: join(dir, ".env"),
      revisionId: revision(2),
      headHash: hash("b"),
    });
    expect(
      (await readPublicationBaseline(dir, environmentId, join(dir, ".env")))
        ?.origin,
    ).toBeUndefined();
  });
});
