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
  lastCommand?: OpenCodeCommand | null;
  lastTurnCompleting: boolean;
};

type GrillIssue = {
  number: number;
  title: string;
  body: string;
  url: string;
  assignees: { login: string }[];
  author: { login: string } | null;
};

type Command = typeof runProcess;
type OpenCodeCommand = "grill-with-docs" | "to-spec";

const priority = (body: string) => {
  const match = /Priority:\s*P(\d+)/i.exec(body);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
};

const grillPrompt = (issue: number, title: string) =>
  `Grill the proposed change in GitHub issue #${issue}: ${title}. Read the issue with gh and inspect the codebase first. Answer anything the repository can answer yourself. Follow the installed grilling and domain-modeling skills exactly, write resolved vocabulary and qualifying ADRs to the checkout as the skill requires, ask one focused round of recommended questions, then stop and wait for the human. Present your questions as plain text and never emit tool call or function call markup in your reply. At the very end of your reply append one fenced code block tagged dotrelay-grill-questions containing the JSON object {"questions":[...]} with one entry per question you asked: "question" (the full question text), "header" (a short label of at most 30 characters), "options" (an array of {"label","description"} suggested answers, best first, or an empty array when you suggest none), and "recommended" (the index of the option you recommend, omitted when you have none). The block is machine-readable data for the panel, not tool call markup. Do not implement the change and do not update the issue labels yet.`;

export type GrillQuestionOption = {
  label: string;
  description: string | null;
};

export type GrillQuestion = {
  question: string;
  header: string | null;
  options: GrillQuestionOption[];
  recommended: number | null;
  multiple: boolean;
};

export type GrillQuestionParse = {
  questions: GrillQuestion[];
  prose: string;
};

const GRILL_QUESTIONS_BLOCK =
  /```dotrelay-grill-questions[ \t]*\r?\n([\s\S]*?)```/;
const MAX_QUESTIONS = 12;
const MAX_OPTIONS = 10;
const MAX_QUESTION_TEXT = 8_000;
const MAX_HEADER = 60;

const collapseBlankLines = (text: string) =>
  text
    .replace(/\n[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const parseGrillQuestionRecords = (records: unknown): GrillQuestion[] => {
  if (!Array.isArray(records)) return [];
  return records.slice(0, MAX_QUESTIONS).flatMap((record): GrillQuestion[] => {
    if (!record || typeof record !== "object") return [];
    const entry = record as Record<string, unknown>;
    const question =
      typeof entry.question === "string" ? entry.question.trim() : "";
    if (!question) return [];
    const options = (Array.isArray(entry.options) ? entry.options : [])
      .slice(0, MAX_OPTIONS)
      .flatMap((option): GrillQuestionOption[] => {
        if (!option || typeof option !== "object") return [];
        const label = (option as { label?: unknown }).label;
        const description = (option as { description?: unknown }).description;
        if (typeof label !== "string" || !label.trim()) return [];
        const detail =
          typeof description === "string" ? description.trim() : "";
        return [{ label: label.trim(), description: detail || null }];
      });
    const recommended =
      typeof entry.recommended === "number" &&
      Number.isInteger(entry.recommended) &&
      entry.recommended >= 0 &&
      entry.recommended < options.length
        ? entry.recommended
        : null;
    const header = typeof entry.header === "string" ? entry.header.trim() : "";
    return [
      {
        question: question.slice(0, MAX_QUESTION_TEXT),
        header: header ? header.slice(0, MAX_HEADER) : null,
        options,
        recommended,
        multiple: entry.multiple === true,
      },
    ];
  });
};

export const parseGrillQuestions = (text: string): GrillQuestionParse => {
  const match = GRILL_QUESTIONS_BLOCK.exec(text);
  if (!match) return { questions: [], prose: text.trim() };
  const block = match[1];
  let payload: unknown = null;
  if (block) {
    try {
      payload = JSON.parse(block);
    } catch {
      payload = null;
    }
  }
  const records =
    payload === null
      ? null
      : Array.isArray(payload)
        ? payload
        : (payload as { questions?: unknown })?.questions;
  const questions = records === null ? [] : parseGrillQuestionRecords(records);
  return {
    questions,
    prose: questions.length
      ? collapseBlankLines(text.replace(GRILL_QUESTIONS_BLOCK, "\n"))
      : text.trim(),
  };
};

export const selectGrillIssue = (issues: GrillIssue[], owner: string) =>
  issues
    .filter(
      (issue) =>
        issue.author?.login === owner &&
        issue.assignees.length === 0 &&
        Number.isFinite(priority(issue.body)),
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

const stripToolCallMarkup = (text: string) =>
  text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, " ")
    .replace(/<\/?tool_call[^>]*>/g, " ")
    .replace(/<\/?function=[^>]*>/g, " ")
    .replace(/<\/?parameter=[^>]*>/g, " ");

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
        const cleaned = stripToolCallMarkup(part.text);
        if (cleaned.trim()) text.push(cleaned);
      }
    } catch {
      // OpenCode may print a non-JSON diagnostic to stderr; the exit code still gates success.
    }
  }
  return { sessionId, text: text.join("").trim() };
};

export const buildOpenCodeRunArguments = (options: {
  checkout: string;
  issue: number | null;
  sessionId: string | null;
  prompt: string;
  command: OpenCodeCommand | null;
  model?: string;
  agent?: string;
}) => {
  const args = [
    "opencode",
    "run",
    "--dir",
    options.checkout,
    "--auto",
    "--format",
    "json",
  ];
  if (options.sessionId) args.push("--session", options.sessionId);
  else args.push("--title", `dotrelay-grill-issue-${options.issue}`);
  if (options.model) args.push("--model", options.model);
  if (options.agent) args.push("--agent", options.agent);
  if (options.command) args.push("--command", options.command);
  args.push(options.prompt);
  return args;
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
  lastCommand: null,
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
    commandName: OpenCodeCommand | null,
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
      lastCommand: commandName,
      lastTurnCompleting: completing,
    });
    const args = buildOpenCodeRunArguments({
      checkout,
      issue: state.issue,
      sessionId: state.sessionId,
      prompt,
      command: commandName,
      ...(process.env.OPENCODE_MODEL
        ? { model: process.env.OPENCODE_MODEL }
        : {}),
      ...(process.env.OPENCODE_AGENT
        ? { agent: process.env.OPENCODE_AGENT }
        : {}),
    });
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
    const owner = await execute(["gh", "api", "user", "--jq", ".login"]);
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
      "number,title,body,url,assignees,author",
    ]);
    const issue = selectGrillIssue(JSON.parse(output) as GrillIssue[], owner);
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
      grillPrompt(issue.number, issue.title),
      false,
      "grill-with-docs",
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
      let state = await read();
      if (
        state.issue &&
        state.lastCommand === undefined &&
        ["preparing", "running", "awaiting-human", "completing"].includes(
          state.status,
        )
      ) {
        state = await save({
          ...state,
          status: "failed",
          message:
            "This grill was started before workflow commands were invoked correctly. Retry it to continue with the repaired command runner.",
        });
      }
      if (
        task === null &&
        state.issue &&
        ["preparing", "running", "completing"].includes(state.status)
      ) {
        state = await save({
          ...state,
          status: "failed",
          message:
            "The panel restarted while this grill turn was in flight, so its result was lost. Retry it to continue.",
        });
      }
      if (["idle", "completed"].includes(state.status)) launch(startNext);
      const current = await read();
      const {
        checkout: _checkout,
        transcript: _transcript,
        lastPrompt: _lastPrompt,
        lastCommand: _lastCommand,
        ...publicState
      } = current;
      return publicState;
    },
    respond: async (answer: string) => {
      const state = await read();
      if (state.status !== "awaiting-human")
        throw new Error("This grill is not waiting for an answer.");
      const trimmed = answer.trim();
      if (!trimmed || trimmed.length > 32_000)
        throw new Error("Answer must be between 1 and 32,000 characters.");
      const prompt = `${trimmed}\n\nWhen you ask your next round of questions, keep appending the dotrelay-grill-questions JSON block exactly as before.`;
      if (!launch(() => runTurn(state, prompt, false, null)))
        throw new Error("A grill turn is already running.");
    },
    complete: async (answer: string) => {
      const state = await read();
      if (state.status !== "awaiting-human")
        throw new Error("This grill is not ready to finish.");
      const prefix = answer.trim()
        ? `The human's final answer is:\n\n${answer.trim()}\n\n`
        : "";
      const prompt = `${prefix}The human confirms that the interview is complete. Turn every exact answer, constraint, negative requirement, ordering guarantee, and numeric default into an implementation-ready GitHub issue #${state.issue}. Resolve nothing by guessing. Verify that grill-with-docs actually wrote any qualifying CONTEXT.md and ADR changes in this checkout. If tracked documentation changed, commit it, push this branch, open a documentation-only PR that references (but does not close) issue #${state.issue}, wait for required checks, and merge it before continuing. Finally replace the ready-for-human label with ready-for-agent using gh, preserving every other label. Do not implement the feature. Only declare success after rereading the issue and confirming it has no unresolved product questions, the label is ready-for-agent, and any documentation PR is merged.`;
      if (!launch(() => runTurn(state, prompt, true, "to-spec")))
        throw new Error("A grill turn is already running.");
    },
    reset: async () => {
      const state = await read();
      if (!state.issue || !state.checkout)
        throw new Error("There is no grill to reset.");
      if (!["awaiting-human", "failed"].includes(state.status))
        throw new Error(
          "The grill is busy; wait for its current turn to settle before resetting it.",
        );
      const checkout = state.checkout;
      const issue = state.issue;
      const issueTitle = state.issueTitle ?? `Issue #${state.issue}`;
      if (
        !launch(async () => {
          await execute(["git", "reset", "--hard", "HEAD"], checkout);
          await execute(["git", "clean", "-fd"], checkout);
          const fresh = await save({
            ...state,
            sessionId: null,
            question: null,
            lastPrompt: null,
            lastCommand: null,
            lastTurnCompleting: false,
            message: "Starting the grill over from the beginning.",
          });
          await runTurn(
            fresh,
            grillPrompt(issue, issueTitle),
            false,
            "grill-with-docs",
          );
        })
      )
        throw new Error("A grill turn is already running.");
    },
    retry: async () => {
      const state = await read();
      if (state.status !== "failed" || !state.issue || !state.lastPrompt)
        throw new Error("There is no failed grill to retry.");
      const legacy = state.lastCommand === undefined;
      const commandName =
        state.lastCommand ??
        (state.lastTurnCompleting
          ? "to-spec"
          : legacy
            ? "grill-with-docs"
            : null);
      const prompt =
        legacy && !state.lastTurnCompleting
          ? grillPrompt(
              state.issue,
              state.issueTitle ?? `Issue #${state.issue}`,
            )
          : state.lastPrompt;
      if (
        !launch(() =>
          runTurn(state, prompt, state.lastTurnCompleting, commandName),
        )
      )
        throw new Error("A grill turn is already running.");
    },
  };
};
