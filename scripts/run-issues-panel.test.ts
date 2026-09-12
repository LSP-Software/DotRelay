import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isProcessRunning,
  isSafeRunLogName,
  readLogChunk,
  summarizeQueue,
} from "./run-issues-panel";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("run issues panel", () => {
  test("accepts only controller log file names", () => {
    expect(isSafeRunLogName("run-20260911T193012Z-1234.log")).toBe(true);
    expect(isSafeRunLogName("issue-12.ndjson")).toBe(false);
    expect(isSafeRunLogName("../run-20260911T193012Z-1234.log")).toBe(false);
    expect(isSafeRunLogName("run-current.log")).toBe(false);
  });

  test("reports the current process as running", () => {
    expect(isProcessRunning(process.pid)).toBe(true);
    expect(isProcessRunning(-1)).toBe(false);
    expect(isProcessRunning(Number.NaN)).toBe(false);
  });

  test("summarizes the persisted controller queue", () => {
    expect(
      summarizeQueue({
        version: 1,
        jobs: [
          { issue: 1, title: "Pending", status: "pending" },
          { issue: 2, title: "Blocked", status: "blocked" },
          { issue: 3, title: "Done", status: "done" },
        ],
      }),
    ).toEqual({ total: 3, pending: 1, blocked: 1, done: 1 });
  });

  test("reads a run log incrementally", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dotrelay-issue-panel-"));
    temporaryDirectories.push(directory);
    const name = "run-20260911T193012Z-1234.log";
    await writeFile(join(directory, name), "first\nsecond\n", "utf8");

    const initial = await readLogChunk(directory, name, null);
    expect(initial).toEqual({
      chunk: "first\nsecond\n",
      nextOffset: 13,
      size: 13,
      reset: true,
    });

    await writeFile(join(directory, name), "first\nsecond\nthird\n", "utf8");
    const update = await readLogChunk(directory, name, initial.nextOffset);
    expect(update).toEqual({
      chunk: "third\n",
      nextOffset: 19,
      size: 19,
      reset: false,
    });
  });

  test("rejects attempts to read outside the run directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dotrelay-issue-panel-"));
    temporaryDirectories.push(directory);

    await expect(
      readLogChunk(directory, "../status.json", null),
    ).rejects.toThrow("Invalid run log name.");
  });
});
