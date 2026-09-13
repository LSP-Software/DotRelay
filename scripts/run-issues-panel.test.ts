import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOpenCodeRunArguments,
  createGrillManager,
  parseOpenCodeTurn,
  selectGrillIssue,
} from "./run-issues-grill";
import {
  createPanelServer,
  isControlRequest,
  isProcessRunning,
  isSafeRunLogName,
  panelHtml,
  readLogChunk,
  renderMarkdown,
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
  test("selects the highest-priority unassigned human issue authored by the owner", () => {
    const issue = selectGrillIssue(
      [
        {
          number: 9,
          title: "P2",
          body: "Priority: P2",
          url: "u9",
          assignees: [],
          author: { login: "sam" },
        },
        {
          number: 4,
          title: "Claimed",
          body: "Priority: P0",
          url: "u4",
          assignees: [{ login: "sam" }],
          author: { login: "sam" },
        },
        {
          number: 7,
          title: "P1",
          body: "Priority: P1",
          url: "u7",
          assignees: [],
          author: { login: "sam" },
        },
        {
          number: 3,
          title: "No priority",
          body: "Idea",
          url: "u3",
          assignees: [],
          author: { login: "sam" },
        },
        {
          number: 2,
          title: "Foreign P0",
          body: "Priority: P0",
          url: "u2",
          assignees: [],
          author: { login: "someone-else" },
        },
      ],
      "sam",
    );
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

  test("discards tool call markup the model emitted as plain text", () => {
    const output = [
      JSON.stringify({
        type: "text",
        sessionID: "ses_123",
        part: {
          text: "<tool_call>\n<function=gh>\n<parameter=command>\ngh issue view 82\n</parameter>\n</function>\n</tool_call>",
        },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "ses_123",
        part: { text: "Which repositories should stay private?" },
      }),
    ].join("\n");
    expect(parseOpenCodeTurn(output)).toEqual({
      sessionId: "ses_123",
      text: "Which repositories should stay private?",
    });
  });

  test("reports no usable question when the turn only emitted tool call markup", () => {
    const output = JSON.stringify({
      type: "text",
      sessionID: "ses_123",
      part: {
        text: "<tool_call>\n<function=read>\n<parameter=filePath>\n/docs/wiki/authentication.md\n</parameter>\n</function>\n</tool_call>",
      },
    });
    expect(parseOpenCodeTurn(output).text).toBe("");
  });

  test("executes workflow commands through OpenCode's command interface", () => {
    const prompt = "Grill issue #79 and ask one focused round of questions.";
    expect(
      buildOpenCodeRunArguments({
        checkout: "/repo/grill/issue-79/checkout",
        issue: 79,
        sessionId: null,
        prompt,
        command: "grill-with-docs",
      }),
    ).toEqual([
      "opencode",
      "run",
      "--dir",
      "/repo/grill/issue-79/checkout",
      "--auto",
      "--format",
      "json",
      "--title",
      "dotrelay-grill-issue-79",
      "--command",
      "grill-with-docs",
      prompt,
    ]);
  });

  test("keeps ordinary human answers as session prompts", () => {
    const args = buildOpenCodeRunArguments({
      checkout: "/repo/grill/issue-79/checkout",
      issue: 79,
      sessionId: "ses_123",
      prompt: "Keep the recovery flow explicit.",
      command: null,
    });
    expect(args).toContain("--session");
    expect(args).not.toContain("--command");
    expect(args.at(-1)).toBe("Keep the recovery flow explicit.");
  });

  test("runs to-spec in the existing grill session", () => {
    const args = buildOpenCodeRunArguments({
      checkout: "/repo/grill/issue-79/checkout",
      issue: 79,
      sessionId: "ses_123",
      prompt: "Prepare issue #79 for the unattended queue.",
      command: "to-spec",
      model: "local/coder",
      agent: "build",
    });
    expect(args).toEqual([
      "opencode",
      "run",
      "--dir",
      "/repo/grill/issue-79/checkout",
      "--auto",
      "--format",
      "json",
      "--session",
      "ses_123",
      "--model",
      "local/coder",
      "--agent",
      "build",
      "--command",
      "to-spec",
      "Prepare issue #79 for the unattended queue.",
    ]);
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

  test("renders safe GitHub-flavoured Markdown for grill questions", () => {
    const html = renderMarkdown(`**Q1** uses \`device_not_active\`.

| State | Action |
| --- | --- |
| Missing Device | **Repair** |

- Keep the existing Device
- Resume the operation

[Documentation](https://example.com/docs)

<img src=x onerror=alert(1)>
[Unsafe](javascript:alert(1))`);
    expect(html).toContain("<strong>Q1</strong>");
    expect(html).toContain("<code>device_not_active</code>");
    expect(html).toContain("<table>");
    expect(html).toContain("<ul>");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain('href="javascript:');
  });

  test("uses only server-sanitized HTML for grill questions", () => {
    expect(panelHtml).toContain(
      "elements.grillQuestion.innerHTML = grill.questionHtml",
    );
    expect(panelHtml).not.toContain(
      "elements.grillQuestion.innerHTML = grill.question ?? grill.message",
    );
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

  test("fails a grill turn orphaned by a panel restart", async () => {
    const runsDirectory = await mkdtemp(
      join(tmpdir(), "dotrelay-issue-panel-"),
    );
    temporaryDirectories.push(runsDirectory);
    const calls: string[][] = [];
    const command = async (args: string[]) => {
      calls.push(args);
      return { code: 0, output: "", stdout: "", infrastructure: false };
    };
    const stateDirectory = join(runsDirectory, "grill");
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(
      join(stateDirectory, "state.json"),
      `${JSON.stringify({
        version: 1,
        status: "running",
        issue: 79,
        issueTitle: "Turn CLI failures into guided recovery",
        issueUrl: "https://github.com/LSP-Software/DotRelay/issues/79",
        priority: 1,
        sessionId: "ses_test",
        question: null,
        message: "The agent is working through this answer.",
        startedAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        turn: 4,
        checkout: join(stateDirectory, "issue-79", "checkout"),
        transcript: join(stateDirectory, "issue-79-turn-4.ndjson"),
        lastPrompt: "I've just installed the skill for you now.",
        lastCommand: null,
        lastTurnCompleting: false,
      })}\n`,
      "utf8",
    );

    const manager = createGrillManager({
      repoRoot: runsDirectory,
      runsDirectory,
      command,
    });
    const state = await manager.ensure();

    expect(state.status).toBe("failed");
    expect(state.message).toMatch(/panel restarted/);
    expect(calls).toEqual([]);
  });

  test("keeps a live grill preparation in flight between status polls", async () => {
    const runsDirectory = await mkdtemp(
      join(tmpdir(), "dotrelay-issue-panel-"),
    );
    temporaryDirectories.push(runsDirectory);
    let releaseClone: () => void = () => {};
    const cloneGate = new Promise<void>((resolve) => {
      releaseClone = resolve;
    });
    const command = async (args: string[]) => {
      if (args[0] === "gh" && args[1] === "api") {
        return {
          code: 0,
          output: "",
          stdout: "testowner",
          infrastructure: false,
        };
      }
      if (args[0] === "gh") {
        return {
          code: 0,
          output: "",
          stdout: JSON.stringify([
            {
              number: 79,
              title: "Turn CLI failures into guided recovery",
              body: "Priority: P1",
              url: "https://github.com/LSP-Software/DotRelay/issues/79",
              assignees: [],
              author: { login: "testowner" },
            },
          ]),
          infrastructure: false,
        };
      }
      if (args[0] === "git" && args[1] === "clone") {
        await cloneGate;
      }
      if (args[0] === "opencode") {
        return {
          code: 0,
          output: "",
          stdout:
            `${JSON.stringify({ type: "step:started", sessionID: "ses_test" })}\n` +
            `${JSON.stringify({ type: "text", part: { text: "Which failure should repair first?" } })}\n`,
          infrastructure: false,
        };
      }
      return { code: 0, output: "", stdout: "", infrastructure: false };
    };
    const manager = createGrillManager({
      repoRoot: runsDirectory,
      runsDirectory,
      command,
    });

    await manager.ensure();
    let state = await manager.read();
    const deadline = Date.now() + 2_000;
    while (state.status !== "preparing" && Date.now() < deadline) {
      await Bun.sleep(10);
      state = await manager.read();
    }
    expect(state.status).toBe("preparing");

    const polled = await manager.ensure();
    expect(polled.status).toBe("preparing");

    releaseClone();
    state = await manager.read();
    const finished = Date.now() + 2_000;
    while (state.status !== "awaiting-human" && Date.now() < finished) {
      await Bun.sleep(10);
      state = await manager.read();
    }
    expect(state.status).toBe("awaiting-human");
    expect(state.question).toBe("Which failure should repair first?");
    expect(state.sessionId).toBe("ses_test");
  });
});
