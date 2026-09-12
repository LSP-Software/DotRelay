import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "./run-issues-process";

export type GrillStatus =
  | "idle"
  | "preparing"
  | "running"
  | "awaiting-human"
  | "completing"
  | "completed"
  | "failed";

export type GrillState = {
  version: 1;
  status: GrillStatus;
  issue: number | null;
  issueTitle: string | null;
  issueUrl: string | null;
  priority: number | null;
  sessionId: string | null;
  question: string | null;
  message: string;
  startedAt: string | null;
  updatedAt: string;
  turn: number;
  checkout: string | null;
  transcript: string | null;
  lastPrompt: string | null;
  lastTurnCompleting: boolean;
};

type GrillIssue = {
  number: number;
  title: string;
  body: string;
  url: string;
  assignees: { login: string }[];
};

type Command = typeof runProcess;

const priority = (body: string) => {
  const match = /Priority:\s*P(\d+)/i.exec(body);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
};

export const selectGrillIssue = (issues: GrillIssue[]) =>
  issues
    .filter(
      (issue) =>
        issue.assignees.length === 0 && Number.isFinite(priority(issue.body)),
    )
    .sort(
      (left, right) =>
        priority(left.body) - priority(right.body) ||
        left.number - right.number,
    )[0] ?? null;

const walk = (value: unknown, key: string): string | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record[key] === "string") return record[key];
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = walk(item, key);
        if (found) return found;
      }
    } else {
      const found = walk(child, key);
      if (found) return found;
    }
  }
  return null;
};

export const parseOpenCodeTurn = (output: string) => {
  let sessionId: string | null = null;
  const text: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      sessionId ??= walk(event, "sessionID") ?? walk(event, "sessionId");
      const part = event.part as Record<string, unknown> | undefined;
      if (event.type === "text" && typeof part?.text === "string") {
        text.push(part.text);
      }
    } catch {
      // OpenCode may print a non-JSON diagnostic to stderr; the exit code still gates success.
    }
  }
  return { sessionId, text: text.join("").trim() };
};

const initialState = (): GrillState => ({
  version: 1,
  status: "idle",
  issue: null,
  issueTitle: null,
  issueUrl: null,
  priority: null,
  sessionId: null,
  question: null,
  message: "Looking for the next ready-for-human issue.",
  startedAt: null,
  updatedAt: new Date().toISOString(),
  turn: 0,
  checkout: null,
  transcript: null,
  lastPrompt: null,
  lastTurnCompleting: false,
});

export const createGrillManager = (options: {
  repoRoot: string;
  runsDirectory: string;
  command?: Command;
  sessionTimeout?: number;
}) => {
  const command = options.command ?? runProcess;
  const directory = join(options.runsDirectory, "grill");
  const statePath = join(directory, "state.json");
  let task: Promise<void> | null = null;

  const save = async (state: GrillState) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${statePath}.${process.pid}.tmp`;
    const next = { ...state, updatedAt: new Date().toISOString() };
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, statePath);
    return next;
  };

  const read = async (): Promise<GrillState> => {
    try {
      return JSON.parse(await readFile(statePath, "utf8")) as GrillState;
    } catch {
      return initialState();
    }
  };

  const execute = async (args: string[], cwd = options.repoRoot) => {
    const result = await command(args, { cwd, timeout: 120_000 });
    if (result.code) throw new Error(result.output || `${args[0]} failed`);
    return result.stdout.trim();
  };

  const prepare = async (issue: GrillIssue) => {
    const issueDirectory = join(directory, `issue-${issue.number}`);
    const checkout = join(issueDirectory, "checkout");
    await mkdir(issueDirectory, { recursive: true, mode: 0o700 });
    try {
      await stat(join(checkout, ".git"));
    } catch {
      const remote = await execute(["git", "remote", "get-url", "origin"]);
      await execute(["git", "clone", "--shared", options.repoRoot, checkout]);
      await execute(["git", "remote", "set-url", "origin", remote], checkout);
      await execute(
        [
          "git",
          "checkout",
          "-b",
          `agent/grill-issue-${issue.number}`,
          "origin/main",
        ],
        checkout,
      );
    }
    return checkout;
  };

  const runTurn = async (
    state: GrillState,
    prompt: string,
    completing: boolean,
  ) => {
    if (!state.checkout) throw new Error("The grill checkout is missing.");
    const checkout = state.checkout;
    const turn = state.turn + 1;
    const transcript = join(
      directory,
      `issue-${state.issue}-turn-${turn}.ndjson`,
    );
    state = await save({
      ...state,
      status: completing ? "completing" : "running",
      question: null,
      message: completing
        ? "Preparing the ticket for the unattended runner."
        : "The agent is working through this answer.",
      turn,
      transcript,
      lastPrompt: prompt,
      lastTurnCompleting: completing,
    });
    const args = [
      "opencode",
      "run",
      "--dir",
      checkout,
      "--auto",
      "--format",
      "json",
    ];
    if (state.sessionId) args.push("--session", state.sessionId);
    else args.push("--title", `dotrelay-grill-issue-${state.issue}`);
    if (process.env.OPENCODE_MODEL)
      args.push("--model", process.env.OPENCODE_MODEL);
    if (process.env.OPENCODE_AGENT)
      args.push("--agent", process.env.OPENCODE_AGENT);
    args.push(prompt);
    const result = await command(args, {
      cwd: checkout,
      timeout: options.sessionTimeout ?? 3_600_000,
    });
    await writeFile(transcript, `${result.stdout}\n`, { mode: 0o600 });
    const parsed = parseOpenCodeTurn(result.stdout);
    if (
      result.code ||
      !parsed.text ||
      (!state.sessionId && !parsed.sessionId)
    ) {
      await save({
        ...state,
        status: "failed",
        sessionId: state.sessionId ?? parsed.sessionId,
        question: parsed.text || null,
        message:
          result.output.slice(-2_000) ||
          "OpenCode did not return a usable grill response.",
      });
      return;
    }
    if (completing) {
      const issueJson = JSON.parse(
        await execute(
          ["gh", "issue", "view", String(state.issue), "--json", "labels,body"],
          checkout,
        ),
      ) as { labels?: { name: string }[]; body?: string };
      const labels = issueJson.labels?.map((label) => label.name) ?? [];
      const dirty = await execute(
        ["git", "status", "--porcelain=v1"],
        checkout,
      );
      if (
        !labels.includes("ready-for-agent") ||
        labels.includes("ready-for-human") ||
        !issueJson.body?.trim() ||
        dirty
      ) {
        const reasons = [
          !labels.includes("ready-for-agent") && "ready-for-agent is missing",
          labels.includes("ready-for-human") &&
            "ready-for-human is still present",
          !issueJson.body?.trim() && "the issue body is empty",
          dirty && "the grill checkout has uncommitted files",
        ].filter(Boolean);
        throw new Error(
          `Grill finalization did not pass verification: ${reasons.join(", ")}.`,
        );
      }
      await save({
        ...state,
        status: "completed",
        sessionId: state.sessionId ?? parsed.sessionId,
        question: parsed.text,
        message: `Issue #${state.issue} was handed back to the unattended queue.`,
      });
      return;
    }
    await save({
      ...state,
      status: "awaiting-human",
      sessionId: state.sessionId ?? parsed.sessionId,
      question: parsed.text,
      message: "The grill is waiting for your answer.",
    });
  };

  const startNext = async () => {
    const output = await execute([
      "gh",
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      "ready-for-human",
      "--limit",
      "100",
      "--json",
      "number,title,body,url,assignees",
    ]);
    const issue = selectGrillIssue(JSON.parse(output) as GrillIssue[]);
    if (!issue) {
      await save({
        ...initialState(),
        message: "No unassigned ready-for-human issues are waiting.",
      });
      return;
    }
    let state = await save({
      ...initialState(),
      status: "preparing",
      issue: issue.number,
      issueTitle: issue.title,
      issueUrl: issue.url,
      priority: priority(issue.body),
      startedAt: new Date().toISOString(),
      message: `Preparing a persistent grill workspace for issue #${issue.number}.`,
    });
    const checkout = await prepare(issue);
    state = await save({ ...state, checkout });
    await runTurn(
      state,
      `/grill-with-docs\n\nGrill the proposed change in GitHub issue #${issue.number}: ${issue.title}. Read the issue with gh and inspect the codebase first. Answer anything the repository can answer yourself. Follow the installed grilling and domain-modeling skills exactly, write resolved vocabulary and qualifying ADRs to the checkout as the skill requires, ask one focused round of recommended questions, then stop and wait for the human. Do not implement the change and do not update the issue labels yet.`,
      false,
    );
  };

  const launch = (work: () => Promise<void>) => {
    if (task) return false;
    task = work()
      .catch(async (error) => {
        const state = await read();
        await save({
          ...state,
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        task = null;
      });
    return true;
  };

  return {
    read,
    ensure: async () => {
      const state = await read();
      if (["idle", "completed"].includes(state.status)) launch(startNext);
      const current = await read();
      const {
        checkout: _checkout,
        transcript: _transcript,
        lastPrompt: _lastPrompt,
        ...publicState
      } = current;
      return publicState;
    },
    respond: async (answer: string) => {
      const state = await read();
      if (state.status !== "awaiting-human")
        throw new Error("This grill is not waiting for an answer.");
      if (!answer.trim() || answer.length > 32_000)
        throw new Error("Answer must be between 1 and 32,000 characters.");
      if (!launch(() => runTurn(state, answer.trim(), false)))
        throw new Error("A grill turn is already running.");
    },
    complete: async (answer: string) => {
      const state = await read();
      if (state.status !== "awaiting-human")
        throw new Error("This grill is not ready to finish.");
      const prefix = answer.trim()
        ? `The human's final answer is:\n\n${answer.trim()}\n\n`
        : "";
      const prompt = `${prefix}The human confirms that the interview is complete. In this same session, run /to-spec and turn every exact answer, constraint, negative requirement, ordering guarantee, and numeric default into an implementation-ready GitHub issue #${state.issue}. Resolve nothing by guessing. Verify that grill-with-docs actually wrote any qualifying CONTEXT.md and ADR changes in this checkout. If tracked documentation changed, commit it, push this branch, open a documentation-only PR that references (but does not close) issue #${state.issue}, wait for required checks, and merge it before continuing. Finally replace the ready-for-human label with ready-for-agent using gh, preserving every other label. Do not implement the feature. Only declare success after rereading the issue and confirming it has no unresolved product questions, the label is ready-for-agent, and any documentation PR is merged.`;
      if (!launch(() => runTurn(state, prompt, true)))
        throw new Error("A grill turn is already running.");
    },
    retry: async () => {
      const state = await read();
      if (state.status !== "failed" || !state.issue || !state.lastPrompt)
        throw new Error("There is no failed grill to retry.");
      if (
        !launch(() =>
          runTurn(state, state.lastPrompt ?? "", state.lastTurnCompleting),
        )
      )
        throw new Error("A grill turn is already running.");
    },
  };
};
