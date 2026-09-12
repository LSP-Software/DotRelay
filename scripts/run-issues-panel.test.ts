import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOpenCodeTurn, selectGrillIssue } from "./run-issues-grill";
import {
  createPanelServer,
  isControlRequest,
  isProcessRunning,
  isSafeRunLogName,
  panelHtml,
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
  test("selects the highest-priority unassigned human issue", () => {
    const issue = selectGrillIssue([
      {
        number: 9,
        title: "P2",
        body: "Priority: P2",
        url: "u9",
        assignees: [],
      },
      {
        number: 4,
        title: "Claimed",
        body: "Priority: P0",
        url: "u4",
        assignees: [{ login: "sam" }],
      },
      {
        number: 7,
        title: "P1",
        body: "Priority: P1",
        url: "u7",
        assignees: [],
      },
      {
        number: 3,
        title: "No priority",
        body: "Idea",
        url: "u3",
        assignees: [],
      },
    ]);
    expect(issue?.number).toBe(7);
  });

  test("extracts the session and exact assistant text from OpenCode events", () => {
    const output = [
      JSON.stringify({
        type: "text",
        sessionID: "ses_123",
        part: { text: "Question one?" },
      }),
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_123",
        part: { tool: "read" },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "ses_123",
        part: { text: "\nQuestion two?" },
      }),
    ].join("\n");
    expect(parseOpenCodeTurn(output)).toEqual({
      sessionId: "ses_123",
      text: "Question one?\nQuestion two?",
    });
  });

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

  test("renders Unicode characters instead of escape sequences", () => {
    expect(panelHtml).toContain("{·}");
    expect(panelHtml).toContain("Waiting for the first run…");
    expect(panelHtml).not.toContain("\\u00b7");
    expect(panelHtml).not.toContain("\\u2026");
    expect(panelHtml).toContain('replace(/\\.log$/, "")');
  });

  test("accepts only same-origin-style POST control requests", () => {
    expect(
      isControlRequest(
        new Request("http://localhost/api/runner/start", {
          method: "POST",
          headers: { "X-DotRelay-Panel": "1", "Sec-Fetch-Site": "same-origin" },
        }),
      ),
    ).toBe(true);
    expect(
      isControlRequest(
        new Request("http://localhost/api/runner/start", { method: "POST" }),
      ),
    ).toBe(false);
    expect(
      isControlRequest(
        new Request("http://localhost/api/runner/start", {
          method: "POST",
          headers: { "X-DotRelay-Panel": "1", "Sec-Fetch-Site": "cross-site" },
        }),
      ),
    ).toBe(false);
  });

  test("starts once and requests a graceful stop through the control API", async () => {
    let starts = 0;
    let stoppedPid: number | null = null;
    const { server } = createPanelServer({
      hostname: "127.0.0.1",
      port: 0,
      startRunner: async () => {
        starts++;
        return process.pid;
      },
      signalRunner: (pid) => {
        stoppedPid = pid;
      },
    });
    const request = (action: string) =>
      fetch(`http://127.0.0.1:${server.port}/api/runner/${action}`, {
        method: "POST",
        headers: { "X-DotRelay-Panel": "1" },
      });

    try {
      expect((await request("start")).status).toBe(202);
      expect((await request("start")).status).toBe(409);
      expect((await request("stop")).status).toBe(202);
      expect(starts).toBe(1);
      expect(Number(stoppedPid)).toBe(process.pid);
    } finally {
      await server.stop(true);
    }
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
