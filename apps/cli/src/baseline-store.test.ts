import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
});
