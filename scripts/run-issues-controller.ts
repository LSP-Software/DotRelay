import { createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { runProcess } from "./run-issues-process";

type Issue = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: { name: string }[];
  assignees: { login: string }[];
  issue_dependencies_summary?: { blocked_by: number };
  pull_request?: unknown;
};
export type Job = {
  issue: number;
  title: string;
  status: "pending" | "blocked" | "done";
  failures: number;
  outages: number;
  nextAttempt: number;
  reason?: string;
};
type State = { version: 1; jobs: Job[] };

export const backoff = (attempt: number, initial: number, cap: number) =>
  Math.min(cap, initial * 2 ** Math.min(20, Math.max(0, attempt - 1)));

export const recordFailure = (
  job: Job,
  infrastructure: boolean,
  now: number,
  settings: {
    attempts: number;
    delay: number;
    outageDelay: number;
    outageCap: number;
  },
) => {
  if (infrastructure) {
    job.outages++;
    job.nextAttempt =
      now + backoff(job.outages, settings.outageDelay, settings.outageCap);
  } else {
    job.failures++;
    job.outages = 0;
    job.nextAttempt = now + settings.delay;
    if (job.failures >= settings.attempts) job.status = "blocked";
  }
};

export const eligible = (issue: Issue) =>
  !issue.pull_request &&
  issue.state === "open" &&
  issue.labels.some((label) => label.name === "ready-for-agent") &&
  issue.issue_dependencies_summary?.blocked_by === 0;
const priority = (issue: Issue) => {
  const match = /Priority:\s*P(\d+)/i.exec(issue.body ?? "");
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
};
export const selectIssues = (issues: Issue[]) =>
  issues
    .filter(
      (issue) =>
        eligible(issue) &&
        issue.assignees.length === 0 &&
        Number.isFinite(priority(issue)),
    )
    .sort((a, b) => priority(a) - priority(b) || a.number - b.number);

const saveJson = async (path: string, value: unknown) => {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
};

export const saveState = (path: string, state: State) => saveJson(path, state);

export const acquireLock = async (
  path: string,
): Promise<() => Promise<void>> => {
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let pid: number;
    try {
      pid = Number(await readFile(join(path, "pid"), "utf8"));
    } catch {
      throw new Error(
        `Lock ${path} has no owner. Inspect it before removing it.`,
      );
    }
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error(`Invalid lock owner at ${path}`);
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      await unlink(join(path, "pid"));
      await rmdir(path);
      return acquireLock(path);
    }
    throw new Error(`Another controller is running with PID ${pid}`);
  }
  await writeFile(join(path, "pid"), `${process.pid}\n`, { mode: 0o600 });
  return async () => {
    await unlink(join(path, "pid"));
    await rmdir(path);
  };
};

const integer = (name: string, fallback: number) => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`${name} must be a positive integer`);
  return Number(value);
};

const pause = async (ms: number, signal: AbortSignal) => {
  signal.throwIfAborted();
  await new Promise<void>((accept, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      accept();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
};

export const main = async (argv = process.argv.slice(2)) => {
  if (argv[0] === "--help") {
    console.log(
      "Usage: ./run-issues.sh [--status | --retry ISSUE]\nSee docs/run-issues.md for configuration and recovery.",
    );
    return 0;
  }
  if (
    argv.length &&
    !(argv.length === 1 && argv[0] === "--status") &&
    !(
      argv.length === 2 &&
      argv[0] === "--retry" &&
      /^[1-9]\d*$/.test(argv[1] ?? "")
    )
  )
    throw new Error("Invalid arguments. Use --help.");
  const settings = {
    attempts: integer("MAX_ISSUE_ATTEMPTS", 3),
    delay: integer("ISSUE_RETRY_DELAY", 300) * 1000,
    outageDelay: integer("OUTAGE_RETRY_DELAY", 60) * 1000,
    outageCap: integer("OUTAGE_RETRY_CAP", 1800) * 1000,
  };
  const commandTimeout = integer("COMMAND_TIMEOUT", 120) * 1000;
  integer("SESSION_TIMEOUT", 3600);
  integer("ISSUE_TIMEOUT", 21600);
  const { MERGE_ADMIN: mergeAdmin, BASE_BRANCH: baseBranch } = process.env;
  if (mergeAdmin && !["0", "1"].includes(mergeAdmin))
    throw new Error("MERGE_ADMIN must be 0 or 1");
  const abort = new AbortController();
  const command = async (args: string[], cwd?: string) => {
    const result = await runProcess(args, {
      cwd,
      timeout: commandTimeout,
      signal: abort.signal,
    });
    if (result.code)
      throw Object.assign(
        new Error(`${args.slice(0, 3).join(" ")}: ${result.output}`),
        { infrastructure: result.infrastructure },
      );
    return result.stdout.trim();
  };
  const root = await command(["git", "rev-parse", "--show-toplevel"]);
  if (argv[0] !== "--status") {
    const preflight = await runProcess(
      ["bash", join(import.meta.dir, "..", "run-issues.sh")],
      {
        cwd: root,
        env: { RUN_ISSUES_WORKER: "1", RUN_ISSUES_PREFLIGHT: "1" },
        signal: abort.signal,
      },
    );
    if (preflight.code) throw new Error(preflight.output);
    // OpenCode prints help to stderr on some versions.
    const help = await runProcess(["opencode", "run", "--help"], {
      cwd: root,
      timeout: commandTimeout,
      signal: abort.signal,
    });
    if (help.code !== 0 || !help.output.includes("--auto"))
      throw new Error("OpenCode run --auto support is required");
  }
  const common = resolve(
    root,
    await command(["git", "rev-parse", "--git-common-dir"], root),
  );
  const directory = join(common, "issue-runner");
  const statePath = join(directory, "state.json");
  if (argv[0] === "--status") {
    try {
      console.log(await readFile(statePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      console.log("No saved issue run.");
    }
    return 0;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const pid = Number(
      await readFile(
        join(common, "opencode-runs", "controller.lock", "pid"),
        "utf8",
      ),
    );
    if (Number.isSafeInteger(pid) && pid > 0) {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        alive = false;
      }
      if (alive)
        throw new Error(`The previous runner is still running with PID ${pid}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const release = await acquireLock(join(directory, "controller.lock"));
  const runId = `${new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")}-${process.pid}`;
  const startedAt = new Date().toISOString();
  const statusPath = join(directory, "status.json");
  const logFile = `run-${runId}.log`;
  const logStream = createWriteStream(join(directory, logFile), {
    flags: "a",
    mode: 0o600,
  });
  const report = (message: string, error = false) => {
    (error ? process.stderr : process.stdout).write(`${message}\n`);
    logStream.write(`${message}\n`);
  };
  const writeStatus = (
    status: "running" | "completed" | "failed" | "attention" | "stopped",
    stage: string,
    message: string,
    job?: Job,
  ) =>
    saveJson(statusPath, {
      version: 1,
      runId,
      status,
      stage,
      message,
      startedAt,
      updatedAt: new Date().toISOString(),
      finishedAt: status === "running" ? null : new Date().toISOString(),
      pid: process.pid,
      controllerPid: process.pid,
      baseBranch: baseBranch ?? "main",
      issue: job?.issue ?? null,
      issueTitle: job?.title ?? null,
      issueUrl: job
        ? `https://github.com/LSP-Software/DotRelay/issues/${job.issue}`
        : null,
      priority: null,
      branch: job ? `agent/issue-${job.issue}` : null,
      prUrl: null,
      logFile,
      activeLogFile: null,
    });
  const stop = () =>
    abort.abort(
      new Error("Controller interrupted; saved work will resume on restart"),
    );
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    report(`DotRelay issue controller started at ${startedAt}`);
    report(`Controller transcript: ${join(directory, logFile)}`);
    await writeStatus("running", "starting", "Issue controller started.");
    let state: State;
    try {
      state = JSON.parse(await readFile(statePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = { version: 1, jobs: [] };
    }
    if (state.version !== 1 || !Array.isArray(state.jobs))
      throw new Error("Invalid saved controller state");
    if (
      new Set(state.jobs.map((job) => job.issue)).size !== state.jobs.length ||
      state.jobs.some(
        (job) =>
          !Number.isSafeInteger(job.issue) ||
          job.issue <= 0 ||
          typeof job.title !== "string" ||
          !["pending", "blocked", "done"].includes(job.status) ||
          [job.failures, job.outages, job.nextAttempt].some(
            (value) => !Number.isSafeInteger(value) || value < 0,
          ),
      )
    )
      throw new Error(
        "Invalid saved issue entry; preserve state.json for inspection",
      );
    const save = () => saveState(statePath, state);
    if (argv[0] === "--retry") {
      const job = state.jobs.find((item) => item.issue === Number(argv[1]));
      if (!job || job.status === "done")
        throw new Error("No unfinished saved job for that issue");
      Object.assign(job, {
        status: "pending",
        failures: 0,
        outages: 0,
        nextAttempt: 0,
        reason: undefined,
      });
      const checkpoint = join(directory, `issue-${job.issue}`, "worker.json");
      try {
        const previous = JSON.parse(await readFile(checkpoint, "utf8"));
        await writeFile(
          checkpoint,
          `${JSON.stringify({ ...previous, repairs: 0 })}\n`,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await save();
    }
    const repo = "LSP-Software/DotRelay";
    const add = (issue: Issue) => {
      if (!state.jobs.some((job) => job.issue === issue.number))
        state.jobs.push({
          issue: issue.number,
          title: issue.title,
          status: "pending",
          failures: 0,
          outages: 0,
          nextAttempt: 0,
        });
    };
    let discoveryFailures = 0;
    while (true) {
      let login: string;
      let issues: Issue[];
      await writeStatus(
        "running",
        "discovering_queue",
        "Discovering ready issues and resumable work.",
      );
      try {
        if (
          (await command(
            [
              "gh",
              "repo",
              "view",
              "--json",
              "nameWithOwner",
              "--jq",
              ".nameWithOwner",
            ],
            root,
          )) !== repo
        )
          throw new Error(`Expected ${repo}`);
        login = await command(["gh", "api", "user", "--jq", ".login"], root);
        issues = (
          JSON.parse(
            await command(
              [
                "gh",
                "api",
                "--paginate",
                "--slurp",
                `repos/${repo}/issues?state=open&per_page=100`,
              ],
              root,
            ),
          ) as Issue[][]
        ).flat();
        const prs = JSON.parse(
          await command(
            [
              "gh",
              "pr",
              "list",
              "--state",
              "open",
              "--author",
              "@me",
              "--base",
              baseBranch ?? "main",
              "--limit",
              "1000",
              "--json",
              "headRefName,isCrossRepository",
            ],
            root,
          ),
        ) as { headRefName: string; isCrossRepository: boolean }[];
        const branches = (
          await command(
            ["git", "for-each-ref", "--format=%(refname:short)", "refs/heads"],
            root,
          )
        ).split("\n");
        for (const issue of issues) {
          const branch = `agent/issue-${issue.number}`;
          const owned =
            issue.assignees.length === 1 && issue.assignees[0]?.login === login;
          if (
            eligible(issue) &&
            owned &&
            (branches.includes(branch) ||
              prs.some(
                (pr) => !pr.isCrossRepository && pr.headRefName === branch,
              ))
          )
            add(issue);
        }
        for (const issue of selectIssues(issues)) add(issue);
        await save();
        discoveryFailures = 0;
      } catch (error) {
        if (!(error as { infrastructure?: boolean }).infrastructure)
          throw error;
        report(`Queue discovery unavailable: ${String(error)}`, true);
        await writeStatus(
          "running",
          "queue_unavailable",
          "GitHub queue discovery is unavailable; waiting to retry.",
        );
        await pause(
          backoff(
            ++discoveryFailures,
            settings.outageDelay,
            settings.outageCap,
          ),
          abort.signal,
        );
        continue;
      }
      const pending = state.jobs.filter((job) => job.status === "pending");
      const job = pending
        .filter((item) => item.nextAttempt <= Date.now())
        .sort((a, b) => a.nextAttempt - b.nextAttempt)[0];
      if (!job) {
        if (!pending.length) {
          const blocked = state.jobs.filter(
            (item) => item.status === "blocked",
          );
          const message = `Queue drained. ${blocked.length} issue(s) need intervention. State: ${statePath}`;
          report(message);
          for (const item of blocked)
            report(`#${item.issue}: ${item.reason}`, true);
          await writeStatus(
            blocked.length ? "attention" : "completed",
            blocked.length ? "needs_attention" : "completed",
            message,
          );
          return blocked.length ? 2 : 0;
        }
        await writeStatus(
          "running",
          "waiting_to_retry",
          "Waiting for the next deferred issue retry.",
        );
        await pause(
          Math.min(
            60_000,
            Math.max(
              1,
              Math.min(...pending.map((item) => item.nextAttempt)) - Date.now(),
            ),
          ),
          abort.signal,
        );
        continue;
      }
      const issue = issues.find((item) => item.number === job.issue);
      if (!issue) {
        try {
          const detail = JSON.parse(
            await command(
              ["gh", "api", `repos/${repo}/issues/${job.issue}`],
              root,
            ),
          ) as Issue;
          if (detail.state === "closed") job.status = "done";
          else recordFailure(job, true, Date.now(), settings);
        } catch (error) {
          abort.signal.throwIfAborted();
          job.reason = String(error);
          recordFailure(
            job,
            !!(error as { infrastructure?: boolean }).infrastructure,
            Date.now(),
            settings,
          );
        }
        await save();
        continue;
      }
      if (
        !eligible(issue) ||
        issue.assignees.some((assignee) => assignee.login !== login)
      ) {
        job.status = "blocked";
        job.reason =
          "Issue is no longer eligible or is assigned to someone else";
        await save();
        continue;
      }
      const jobDirectory = join(directory, `issue-${job.issue}`);
      const checkout = join(jobDirectory, "checkout");
      const marker = join(jobDirectory, "infrastructure");
      const unsafe = join(jobDirectory, "unsafe-process-cleanup");
      await mkdir(jobDirectory, { recursive: true, mode: 0o700 });
      try {
        if (await Bun.file(unsafe).exists())
          throw Object.assign(
            new Error(
              `Inspect process cleanup failure in ${unsafe} before restarting`,
            ),
            { unsafe: true },
          );
        // A private clone preserves unfinished work without switching the user's branch.
        const exists = await runProcess(
          ["git", "-C", checkout, "rev-parse", "--show-toplevel"],
          { signal: abort.signal },
        );
        if (exists.code) {
          try {
            await stat(checkout);
            throw new Error(
              `Existing checkout is not a valid repository: ${checkout}`,
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          const preparing = await mkdtemp(join(jobDirectory, "preparing-"));
          await command(
            ["git", "clone", "--no-hardlinks", root, preparing],
            root,
          );
          await rename(preparing, checkout);
        } else if (resolve(exists.output) !== checkout)
          throw new Error("Checkout resolved to another repository");
        const origin = await command(
          ["git", "remote", "get-url", "origin"],
          root,
        );
        await command(["git", "remote", "set-url", "origin", origin], checkout);
        // Clone includes source HEAD's committed work; other local issue branches
        // need an explicit import before origin is refreshed by the worker.
        const branch = `agent/issue-${job.issue}`;
        const local = await runProcess(
          ["git", "show-ref", "--verify", "--hash", `refs/heads/${branch}`],
          { cwd: root, signal: abort.signal },
        );
        const imported = await runProcess(
          ["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
          { cwd: checkout, signal: abort.signal },
        );
        if (!local.code && imported.code)
          await command(["git", "branch", branch, local.output], checkout);
        await unlink(marker).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        await writeStatus(
          "running",
          "preparing_issue",
          `Preparing issue #${job.issue}.`,
          job,
        );
        report(`Processing #${job.issue}: ${job.title}. Checkout: ${checkout}`);
        const result = await runProcess(
          ["bash", join(import.meta.dir, "..", "run-issues.sh")],
          {
            cwd: checkout,
            signal: abort.signal,
            live: true,
            timeout: integer("ISSUE_TIMEOUT", 21600) * 1000,
            env: {
              RUN_ISSUES_WORKER: "1",
              RUN_ISSUE_NUMBER: String(job.issue),
              RUN_ISSUE_LOGIN: login,
              WORKER_STATE: join(jobDirectory, "worker.json"),
              RUN_INFRA_MARKER: marker,
              RUN_UNSAFE_MARKER: unsafe,
              RUN_STATUS_PATH: statusPath,
              RUN_CONTROLLER_PID: String(process.pid),
              RUN_CONTROLLER_LOG_FILE: logFile,
              RUN_ID: runId,
              RUN_STARTED_AT: startedAt,
            },
            onOutput: (data) => logStream.write(data),
          },
        );
        await writeStatus(
          "running",
          "recording_result",
          `Recording the result for issue #${job.issue}.`,
          job,
        );
        if (result.code === 70 || (await Bun.file(unsafe).exists())) {
          await writeFile(unsafe, result.output);
          throw Object.assign(
            new Error(`Could not confirm process cleanup. Inspect ${unsafe}`),
            { unsafe: true },
          );
        }
        if (!result.code) {
          job.status = "done";
          delete job.reason;
        } else {
          job.reason = result.output.slice(-4000);
          const marked = await readFile(marker, "utf8").then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
              return false;
            },
          );
          recordFailure(
            job,
            result.code === 75 || marked,
            Date.now(),
            settings,
          );
          if (result.code === 78) job.status = "blocked";
        }
      } catch (error) {
        abort.signal.throwIfAborted();
        if ((error as { unsafe?: boolean }).unsafe) throw error;
        job.reason = String(error);
        recordFailure(
          job,
          !!(error as { infrastructure?: boolean }).infrastructure,
          Date.now(),
          settings,
        );
      }
      await save();
      report(
        `#${job.issue}: ${job.status}${job.status === "pending" ? `; retry after ${new Date(job.nextAttempt).toISOString()}` : ""}`,
      );
    }
  } catch (error) {
    const stopped = abort.signal.aborted;
    await writeStatus(
      stopped ? "stopped" : "failed",
      stopped ? "stopped" : "controller_failed",
      error instanceof Error ? error.message : String(error),
    ).catch(() => undefined);
    throw error;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await new Promise<void>((accept) => logStream.end(accept));
    await release();
  }
};

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
