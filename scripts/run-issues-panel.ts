import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const DEFAULT_PORT = 4173;
const MAX_LOG_CHUNK_BYTES = 128 * 1024;
const INITIAL_LOG_BYTES = 96 * 1024;
const RUN_LOG_PATTERN = /^run-\d{8}T\d{6}Z-\d+\.log$/;

type RunnerStatus = {
  version: number;
  runId: string;
  status: "running" | "completed" | "failed" | "attention" | "stopped";
  stage: string;
  message: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  pid: number;
  controllerPid?: number;
  baseBranch: string;
  issue: number | null;
  issueTitle: string | null;
  issueUrl: string | null;
  priority: number | null;
  branch: string | null;
  prUrl: string | null;
  logFile: string;
  activeLogFile: string | null;
};

type ControllerState = {
  version: 1;
  jobs: {
    issue: number;
    title: string;
    status: "pending" | "blocked" | "done";
  }[];
};

export const summarizeQueue = (state: ControllerState | null) => ({
  total: state?.jobs.length ?? 0,
  pending: state?.jobs.filter((job) => job.status === "pending").length ?? 0,
  blocked: state?.jobs.filter((job) => job.status === "blocked").length ?? 0,
  done: state?.jobs.filter((job) => job.status === "done").length ?? 0,
});

type RunLog = {
  name: string;
  size: number;
  modifiedAt: string;
};

const repoRoot = resolve(import.meta.dir, "..");
const runsDirectory = resolve(
  process.env.ISSUES_PANEL_RUNS_DIR ?? join(repoRoot, ".git", "issue-runner"),
);

export const isSafeRunLogName = (name: string) =>
  RUN_LOG_PATTERN.test(name) && basename(name) === name;

export const isProcessRunning = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readRunnerStatus = async (): Promise<RunnerStatus | null> => {
  try {
    const statusContent = await readFile(
      join(runsDirectory, "status.json"),
      "utf8",
    );
    return JSON.parse(statusContent) as RunnerStatus;
  } catch {
    return null;
  }
};

const readControllerState = async (): Promise<ControllerState | null> => {
  try {
    return JSON.parse(
      await readFile(join(runsDirectory, "state.json"), "utf8"),
    ) as ControllerState;
  } catch {
    return null;
  }
};

const readControllerPid = async () => {
  try {
    const pid = Number(
      await readFile(join(runsDirectory, "controller.lock", "pid"), "utf8"),
    );
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

const startRunner = async () =>
  new Promise<number>((accept, reject) => {
    const child = spawn("bash", [join(repoRoot, "run-issues.sh")], {
      cwd: repoRoot,
      detached: true,
      env: { ...process.env, RUN_ISSUES_WORKER: "0" },
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      if (!child.pid) {
        reject(new Error("Runner started without a process ID."));
        return;
      }
      child.unref();
      accept(child.pid);
    });
  });

export const isControlRequest = (request: Request) =>
  request.method === "POST" &&
  request.headers.get("x-dotrelay-panel") === "1" &&
  !["cross-site", "same-site"].includes(
    request.headers.get("sec-fetch-site") ?? "",
  );

const listRunLogs = async (): Promise<RunLog[]> => {
  try {
    const entries = await readdir(runsDirectory, { withFileTypes: true });
    const logs = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && isSafeRunLogName(entry.name))
        .map(async (entry) => {
          const fileStat = await stat(join(runsDirectory, entry.name));
          return {
            name: entry.name,
            size: fileStat.size,
            modifiedAt: fileStat.mtime.toISOString(),
          };
        }),
    );

    return logs
      .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
      .slice(0, 20);
  } catch {
    return [];
  }
};

export const readLogChunk = async (
  directory: string,
  name: string,
  requestedOffset: number | null,
) => {
  if (!isSafeRunLogName(name)) {
    throw new Error("Invalid run log name.");
  }

  const path = join(directory, name);
  const fileStat = await stat(path);
  const hasOffset = requestedOffset !== null;
  const normalizedOffset =
    hasOffset && requestedOffset >= 0 && requestedOffset <= fileStat.size
      ? requestedOffset
      : Math.max(0, fileStat.size - INITIAL_LOG_BYTES);
  const end = Math.min(fileStat.size, normalizedOffset + MAX_LOG_CHUNK_BYTES);
  const chunk = await Bun.file(path).slice(normalizedOffset, end).text();

  return {
    chunk,
    nextOffset: end,
    size: fileStat.size,
    reset: !hasOffset || normalizedOffset !== requestedOffset,
  };
};

const jsonResponse = (body: unknown, init?: ResponseInit) =>
  Response.json(body, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...init?.headers,
    },
  });

export const panelHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <title>DotRelay Issue Runner</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #07100f;
        --panel: #0b1715;
        --panel-raised: #10201d;
        --line: #213b35;
        --line-strong: #31564d;
        --text: #ecf9f5;
        --muted: #88a49c;
        --green: #62f6b5;
        --green-soft: rgba(98, 246, 181, 0.12);
        --amber: #f9c86b;
        --red: #ff817a;
        --cyan: #62dff6;
        --shadow: 0 24px 80px rgba(0, 0, 0, 0.32);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      * { box-sizing: border-box; }

      body {
        min-width: 320px;
        margin: 0;
        background:
          radial-gradient(circle at 8% -10%, rgba(98, 246, 181, 0.12), transparent 32rem),
          linear-gradient(135deg, rgba(98, 223, 246, 0.03), transparent 36%),
          var(--bg);
        color: var(--text);
      }

      button, a { font: inherit; }
      a { color: inherit; }

      .shell {
        width: min(1600px, 100%);
        min-height: 100vh;
        margin: 0 auto;
        padding: 1.25rem;
      }

      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        min-height: 4rem;
        margin-bottom: 1.25rem;
      }

      .brand { display: flex; align-items: center; gap: 0.8rem; }
      .mark {
        display: grid;
        width: 2.5rem;
        height: 2.5rem;
        place-items: center;
        border: 1px solid rgba(98, 246, 181, 0.35);
        border-radius: 0.75rem;
        background: var(--green-soft);
        color: var(--green);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-weight: 700;
        box-shadow: inset 0 0 18px rgba(98, 246, 181, 0.06);
      }
      .brand h1 { margin: 0; font-size: 1.05rem; letter-spacing: -0.01em; }
      .brand p { margin: 0.2rem 0 0; color: var(--muted); font-size: 0.78rem; }

      .connection {
        display: inline-flex;
        align-items: center;
        gap: 0.55rem;
        color: var(--muted);
        font-size: 0.82rem;
      }
      .header-actions { display: flex; align-items: center; gap: 0.65rem; }
      .dot { width: 0.55rem; height: 0.55rem; border-radius: 50%; background: var(--muted); }
      .dot.live { background: var(--green); box-shadow: 0 0 0 0.3rem rgba(98, 246, 181, 0.09); }
      .dot.error { background: var(--red); }
      .dot.attention { background: var(--amber); box-shadow: 0 0 0 0.3rem rgba(249, 200, 107, 0.09); }

      .layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 18rem;
        gap: 1rem;
      }

      .main { display: grid; min-width: 0; gap: 1rem; }
      .summary {
        display: grid;
        grid-template-columns: minmax(18rem, 1.5fr) repeat(4, minmax(8rem, 0.55fr));
        border: 1px solid var(--line);
        border-radius: 1rem;
        overflow: hidden;
        background: rgba(11, 23, 21, 0.88);
        box-shadow: var(--shadow);
      }

      .summary > div { min-width: 0; padding: 1.15rem 1.25rem; }
      .summary > div + div { border-left: 1px solid var(--line); }
      .eyebrow {
        margin: 0 0 0.6rem;
        color: var(--muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.72rem;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .status-line { display: flex; align-items: center; gap: 0.7rem; }
      .status-line strong { font-size: clamp(1.2rem, 2vw, 1.55rem); letter-spacing: -0.025em; }
      .message { margin: 0.55rem 0 0; overflow: hidden; color: var(--muted); font-size: 0.88rem; text-overflow: ellipsis; white-space: nowrap; }
      .metric { margin: 0; overflow: hidden; font-size: 0.96rem; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
      .metric a { color: var(--cyan); text-decoration: none; }
      .metric a:hover { text-decoration: underline; }
      .submetric { margin: 0.35rem 0 0; overflow: hidden; color: var(--muted); font-size: 0.75rem; text-overflow: ellipsis; white-space: nowrap; }

      .terminal {
        display: grid;
        min-height: calc(100vh - 10.5rem);
        grid-template-rows: auto 1fr;
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: 1rem;
        background: rgba(5, 12, 11, 0.96);
        box-shadow: var(--shadow);
      }
      .terminal-bar {
        display: flex;
        min-height: 3.25rem;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 0.75rem 1rem;
        border-bottom: 1px solid var(--line);
        background: var(--panel);
      }
      .terminal-title { display: flex; min-width: 0; align-items: center; gap: 0.75rem; }
      .traffic { display: flex; gap: 0.35rem; }
      .traffic span { width: 0.55rem; height: 0.55rem; border-radius: 50%; background: var(--line-strong); }
      .log-name {
        overflow: hidden;
        color: var(--muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.78rem;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .terminal-actions { display: flex; align-items: center; gap: 0.5rem; }
      .button {
        min-height: 2.1rem;
        padding: 0.38rem 0.7rem;
        border: 1px solid var(--line-strong);
        border-radius: 0.55rem;
        background: transparent;
        color: var(--muted);
        cursor: pointer;
        font-size: 0.78rem;
      }
      .button:hover, .button.active { border-color: rgba(98, 246, 181, 0.55); background: var(--green-soft); color: var(--green); }
      .button.stop:hover:not(:disabled) { border-color: rgba(255, 129, 122, 0.55); background: rgba(255, 129, 122, 0.1); color: var(--red); }
      .button:disabled { cursor: not-allowed; opacity: 0.4; }
      pre {
        min-height: 0;
        margin: 0;
        padding: 1.2rem;
        overflow: auto;
        color: #c7ddd6;
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
        font-size: 0.82rem;
        line-height: 1.65;
        tab-size: 2;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .empty { display: grid; place-items: center; color: var(--muted); }

      aside {
        align-self: start;
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: 1rem;
        background: rgba(11, 23, 21, 0.88);
        box-shadow: var(--shadow);
      }
      aside h2 { margin: 0; padding: 1rem; border-bottom: 1px solid var(--line); font-size: 0.88rem; }
      .runs { display: grid; max-height: calc(100vh - 7.75rem); overflow-y: auto; }
      .run {
        display: grid;
        gap: 0.35rem;
        width: 100%;
        padding: 0.9rem 1rem;
        border: 0;
        border-bottom: 1px solid var(--line);
        background: transparent;
        color: inherit;
        text-align: left;
        cursor: pointer;
      }
      .run:hover, .run.selected { background: var(--green-soft); }
      .run.selected { box-shadow: inset 2px 0 var(--green); }
      .run strong { overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.76rem; text-overflow: ellipsis; white-space: nowrap; }
      .run span { color: var(--muted); font-size: 0.75rem; }

      @media (max-width: 1050px) {
        .layout { grid-template-columns: 1fr; }
        aside { order: 2; }
        .runs { max-height: 16rem; }
        .terminal { min-height: 34rem; }
      }
      @media (max-width: 760px) {
        .shell { padding: 0.75rem; }
        header { align-items: flex-start; }
        .brand p { display: none; }
        .header-actions { align-items: flex-end; flex-direction: column-reverse; }
        .summary { grid-template-columns: 1fr 1fr; }
        .summary > div:first-child { grid-column: 1 / -1; }
        .summary > div + div { border-left: 0; }
        .summary > div:nth-child(odd):not(:first-child) { border-left: 1px solid var(--line); }
        .summary > div:nth-child(n + 2) { border-top: 1px solid var(--line); }
        .terminal-bar { align-items: flex-start; flex-direction: column; }
        .terminal-actions { width: 100%; }
        .button { flex: 1; }
        pre { padding: 0.9rem; font-size: 0.76rem; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header>
        <div class="brand">
          <div class="mark" aria-hidden="true">{·}</div>
          <div><h1>Issue runner</h1><p>DotRelay automation monitor</p></div>
        </div>
        <div class="header-actions">
          <button class="button" id="start-runner" type="button">Start runner</button>
          <button class="button stop" id="stop-runner" type="button" disabled>Stop runner</button>
          <div class="connection"><span class="dot" id="connection-dot"></span><span id="connection-label">Connecting</span></div>
        </div>
      </header>

      <div class="layout">
        <main class="main">
          <section class="summary" aria-label="Current run">
            <div>
              <p class="eyebrow">Current stage</p>
              <div class="status-line"><span class="dot" id="status-dot"></span><strong id="stage">Waiting for data</strong></div>
              <p class="message" id="message">The panel has not received runner status yet.</p>
            </div>
            <div><p class="eyebrow">Issue</p><p class="metric" id="issue">—</p><p class="submetric" id="issue-title"></p></div>
            <div><p class="eyebrow">Queue</p><p class="metric" id="queue">—</p><p class="submetric" id="queue-detail"></p></div>
            <div><p class="eyebrow">Elapsed</p><p class="metric" id="elapsed">—</p></div>
            <div><p class="eyebrow">Pull request</p><p class="metric" id="pull-request">—</p></div>
          </section>

          <section class="terminal">
            <div class="terminal-bar">
              <div class="terminal-title">
                <div class="traffic" aria-hidden="true"><span></span><span></span><span></span></div>
                <span class="log-name" id="log-name">No run selected</span>
              </div>
              <div class="terminal-actions">
                <button class="button active" id="follow" type="button">Follow latest</button>
                <button class="button" id="copy" type="button">Copy visible log</button>
              </div>
            </div>
            <pre class="empty" id="log" tabindex="0">Waiting for the first run…</pre>
          </section>
        </main>

        <aside>
          <h2>Recent runs</h2>
          <div class="runs" id="runs"><div class="run"><span>No run logs found.</span></div></div>
        </aside>
      </div>
    </div>

    <script>
      const elements = {
        connectionDot: document.querySelector("#connection-dot"),
        connectionLabel: document.querySelector("#connection-label"),
        statusDot: document.querySelector("#status-dot"),
        stage: document.querySelector("#stage"),
        message: document.querySelector("#message"),
        issue: document.querySelector("#issue"),
        issueTitle: document.querySelector("#issue-title"),
        queue: document.querySelector("#queue"),
        queueDetail: document.querySelector("#queue-detail"),
        elapsed: document.querySelector("#elapsed"),
        pullRequest: document.querySelector("#pull-request"),
        logName: document.querySelector("#log-name"),
        log: document.querySelector("#log"),
        runs: document.querySelector("#runs"),
        follow: document.querySelector("#follow"),
        copy: document.querySelector("#copy"),
        startRunner: document.querySelector("#start-runner"),
        stopRunner: document.querySelector("#stop-runner"),
      };

      let selectedRun = null;
      let currentRun = null;
      let offset = null;
      let followLatest = true;
      let startedAt = null;
      let finishedAt = null;
      let statusTimer = null;
      let logTimer = null;

      const stageNames = {
        starting: "Starting",
        starting_worker: "Starting worker",
        discovering_queue: "Discovering queue",
        queue_unavailable: "Queue unavailable",
        waiting_to_retry: "Waiting to retry",
        preparing_issue: "Preparing issue",
        recording_result: "Recording result",
        needs_attention: "Needs attention",
        controller_failed: "Controller failed",
        stopped: "Stopped",
        loading_issue: "Loading issue",
        resuming_pr: "Resuming pull request",
        claiming_issue: "Claiming issue",
        implementing: "Implementing",
        validating_implementation: "Validating implementation",
        pushing_branch: "Pushing branch",
        opening_pr: "Opening pull request",
        pr_open: "Pull request opened",
        validating_pr: "Validating pull request",
        waiting_for_ci: "Waiting for CI",
        repairing_pr: "Repairing pull request",
        validating_repair: "Validating repair",
        pushing_repair: "Pushing repair",
        merging: "Merging",
        worker_complete: "Worker complete",
        completed: "Queue complete",
      };

      const formatDuration = (start, end) => {
        if (!start) return "—";
        const endTime = end ? new Date(end).getTime() : Date.now();
        const seconds = Math.max(0, Math.floor((endTime - new Date(start).getTime()) / 1000));
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        if (hours > 0) return hours + "h " + minutes + "m";
        return minutes + "m " + (seconds % 60) + "s";
      };

      const formatBytes = (bytes) => {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / 1024 / 1024).toFixed(1) + " MB";
      };

      const setLink = (target, label, url) => {
        target.replaceChildren();
        if (!url) {
          target.textContent = label;
          return;
        }
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = label;
        target.append(link);
      };

      const renderRuns = (runs) => {
        elements.runs.replaceChildren();
        if (!runs.length) {
          const empty = document.createElement("div");
          empty.className = "run";
          empty.textContent = "No run logs found.";
          elements.runs.append(empty);
          return;
        }

        for (const run of runs) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "run" + (run.name === selectedRun ? " selected" : "");
          const title = document.createElement("strong");
          title.textContent = run.name.replace(/^run-/, "").replace(/\\.log$/, "");
          const meta = document.createElement("span");
          meta.textContent = new Date(run.modifiedAt).toLocaleString() + " · " + formatBytes(run.size);
          button.append(title, meta);
          button.addEventListener("click", () => selectRun(run.name, false));
          elements.runs.append(button);
        }
      };

      const selectRun = (name, follow) => {
        selectedRun = name;
        followLatest = follow;
        offset = null;
        elements.log.textContent = "";
        elements.log.classList.remove("empty");
        elements.logName.textContent = name;
        elements.follow.classList.toggle("active", followLatest);
        void refreshStatus();
        void refreshLog();
      };

      const refreshStatus = async () => {
        try {
          const response = await fetch("/api/status", { cache: "no-store" });
          if (!response.ok) throw new Error("Status request failed");
          const data = await response.json();
          const status = data.status;
          const queue = data.queue;

          elements.connectionDot.className = "dot live";
          elements.connectionLabel.textContent = "Panel connected";
          elements.startRunner.disabled = data.processRunning;
          elements.stopRunner.disabled = !data.processRunning;
          currentRun = status?.logFile ?? data.runs[0]?.name ?? null;
          startedAt = status?.startedAt ?? null;
          finishedAt = status?.finishedAt ?? null;
          elements.queue.textContent = queue.total ? queue.pending + " pending" : "Empty";
          elements.queueDetail.textContent = queue.done + " done · " + queue.blocked + " blocked";

          if (followLatest && currentRun && selectedRun !== currentRun) {
            selectRun(currentRun, true);
            return;
          }
          if (!selectedRun && currentRun) selectRun(currentRun, true);

          if (!status) {
            elements.statusDot.className = "dot";
            elements.stage.textContent = "No runner status";
            elements.message.textContent = "Start run-issues.sh to populate this panel.";
            setLink(elements.issue, "—", null);
            elements.issueTitle.textContent = "";
            setLink(elements.pullRequest, "—", null);
          } else {
            const unexpectedlyStopped = status.status === "running" && !data.processRunning;
            const visualStatus = unexpectedlyStopped ? "failed" : status.status;
            elements.statusDot.className = "dot " + (visualStatus === "running" ? "live" : visualStatus === "failed" ? "error" : visualStatus === "attention" || visualStatus === "stopped" ? "attention" : "");
            elements.stage.textContent = unexpectedlyStopped
              ? "Runner stopped"
              : status.status === "failed"
                ? "Failed · " + (stageNames[status.stage] ?? status.stage.replaceAll("_", " "))
                : (stageNames[status.stage] ?? status.stage.replaceAll("_", " "));
            elements.message.textContent = unexpectedlyStopped
              ? "The recorded runner process is no longer active. Check the log for its final output."
              : status.message;
            setLink(
              elements.issue,
              status.issue ? "P" + (status.priority ?? "?") + " · #" + status.issue : "—",
              status.issueUrl,
            );
            elements.issueTitle.textContent = status.issueTitle ?? "";
            setLink(elements.pullRequest, status.prUrl ? "Open PR ↗" : "Not opened", status.prUrl);
          }

          elements.elapsed.textContent = formatDuration(startedAt, finishedAt);
          renderRuns(data.runs);
        } catch {
          elements.connectionDot.className = "dot error";
          elements.connectionLabel.textContent = "Panel disconnected";
          elements.startRunner.disabled = true;
          elements.stopRunner.disabled = true;
        }
      };

      const controlRunner = async (action) => {
        const button = action === "start" ? elements.startRunner : elements.stopRunner;
        const originalLabel = button.textContent;
        button.disabled = true;
        button.textContent = action === "start" ? "Starting…" : "Stopping…";
        try {
          const response = await fetch("/api/runner/" + action, {
            method: "POST",
            headers: { "X-DotRelay-Panel": "1" },
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error ?? "Runner control failed.");
          elements.message.textContent = result.message;
        } catch (error) {
          elements.message.textContent = error instanceof Error ? error.message : String(error);
        } finally {
          button.textContent = originalLabel;
          await refreshStatus();
        }
      };

      const refreshLog = async () => {
        if (!selectedRun) return;
        try {
          const query = new URLSearchParams({ run: selectedRun });
          if (offset !== null) query.set("offset", String(offset));
          const response = await fetch("/api/log?" + query, { cache: "no-store" });
          if (!response.ok) throw new Error("Log request failed");
          const data = await response.json();
          if (data.reset) elements.log.textContent = "";
          if (data.chunk) {
            const shouldScroll = elements.log.scrollHeight - elements.log.scrollTop - elements.log.clientHeight < 80;
            elements.log.append(document.createTextNode(data.chunk));
            if (followLatest || shouldScroll) elements.log.scrollTop = elements.log.scrollHeight;
          }
          offset = data.nextOffset;
        } catch {
          // The status poll owns the visible connection state.
        }
      };

      elements.follow.addEventListener("click", () => {
        followLatest = true;
        elements.follow.classList.add("active");
        if (currentRun) selectRun(currentRun, true);
      });

      elements.copy.addEventListener("click", async () => {
        await navigator.clipboard.writeText(elements.log.textContent ?? "");
        elements.copy.textContent = "Copied";
        window.setTimeout(() => { elements.copy.textContent = "Copy visible log"; }, 1200);
      });
      elements.startRunner.addEventListener("click", () => void controlRunner("start"));
      elements.stopRunner.addEventListener("click", () => void controlRunner("stop"));

      statusTimer = window.setInterval(() => void refreshStatus(), 2000);
      logTimer = window.setInterval(() => void refreshLog(), 1000);
      window.addEventListener("beforeunload", () => {
        window.clearInterval(statusTimer);
        window.clearInterval(logTimer);
      });
      void refreshStatus();
      void refreshLog();
    </script>
  </body>
</html>`;

const contentSecurityPolicy = [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const createPanelServer = (
  options: {
    hostname?: string;
    port?: number;
    startRunner?: () => Promise<number>;
    signalRunner?: (pid: number) => void;
  } = {},
) => {
  const configuredPort =
    options.port ?? Number(process.env.ISSUES_PANEL_PORT ?? DEFAULT_PORT);
  if (
    !Number.isSafeInteger(configuredPort) ||
    configuredPort < (options.port === 0 ? 0 : 1) ||
    configuredPort > 65_535
  ) {
    throw new Error(
      "ISSUES_PANEL_PORT must be an integer between 1 and 65535.",
    );
  }

  const hostname =
    options.hostname ?? process.env.ISSUES_PANEL_HOST ?? "127.0.0.1";
  const launchRunner = options.startRunner ?? startRunner;
  const signalRunner =
    options.signalRunner ?? ((pid) => process.kill(pid, "SIGTERM"));
  let launchedPid: number | null = null;
  const activeRunnerPid = async (status?: RunnerStatus | null) => {
    const lockedPid = await readControllerPid();
    if (lockedPid && isProcessRunning(lockedPid)) launchedPid = null;
    const candidates = [
      lockedPid,
      launchedPid,
      status?.status === "running" ? status.controllerPid : undefined,
      status?.status === "running" ? status.pid : undefined,
    ];
    const active = candidates.find(
      (pid): pid is number =>
        pid !== undefined && pid !== null && isProcessRunning(pid),
    );
    if (!active) launchedPid = null;
    return active ?? null;
  };
  const server = Bun.serve({
    hostname,
    port: configuredPort,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/api/runner/start") {
        if (!isControlRequest(request)) {
          return jsonResponse(
            { error: "Runner control requires a same-origin panel request." },
            { status: request.method === "POST" ? 403 : 405 },
          );
        }
        if (await activeRunnerPid()) {
          return jsonResponse(
            { error: "The issue runner is already running." },
            { status: 409 },
          );
        }
        try {
          launchedPid = await launchRunner();
          return jsonResponse(
            {
              ok: true,
              message: "Runner start requested.",
              pid: launchedPid,
            },
            { status: 202 },
          );
        } catch (error) {
          return jsonResponse(
            {
              error:
                error instanceof Error
                  ? error.message
                  : "Could not start the issue runner.",
            },
            { status: 500 },
          );
        }
      }

      if (url.pathname === "/api/runner/stop") {
        if (!isControlRequest(request)) {
          return jsonResponse(
            { error: "Runner control requires a same-origin panel request." },
            { status: request.method === "POST" ? 403 : 405 },
          );
        }
        const pid = await activeRunnerPid();
        if (!pid) {
          return jsonResponse(
            { error: "The issue runner is not running." },
            { status: 409 },
          );
        }
        try {
          signalRunner(pid);
          return jsonResponse(
            { ok: true, message: "Graceful runner stop requested.", pid },
            { status: 202 },
          );
        } catch (error) {
          return jsonResponse(
            {
              error:
                error instanceof Error
                  ? error.message
                  : "Could not stop the issue runner.",
            },
            { status: 500 },
          );
        }
      }

      if (request.method !== "GET") {
        return jsonResponse(
          { error: "Method not allowed." },
          { status: 405, headers: { Allow: "GET" } },
        );
      }

      if (url.pathname === "/") {
        return new Response(panelHtml, {
          headers: {
            "Cache-Control": "no-store",
            "Content-Security-Policy": contentSecurityPolicy,
            "Content-Type": "text/html; charset=utf-8",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
          },
        });
      }

      if (url.pathname === "/api/status") {
        const [status, runs, state] = await Promise.all([
          readRunnerStatus(),
          listRunLogs(),
          readControllerState(),
        ]);
        const runnerPid = await activeRunnerPid(status);
        return jsonResponse({
          status,
          processRunning: runnerPid !== null,
          queue: summarizeQueue(state),
          runs,
          serverTime: new Date().toISOString(),
        });
      }

      if (url.pathname === "/api/log") {
        const name = url.searchParams.get("run") ?? "";
        const offsetValue = url.searchParams.get("offset");
        const offset = offsetValue === null ? null : Number(offsetValue);
        if (
          !isSafeRunLogName(name) ||
          (offset !== null && (!Number.isSafeInteger(offset) || offset < 0))
        ) {
          return jsonResponse(
            { error: "Invalid log request." },
            { status: 400 },
          );
        }

        try {
          return jsonResponse(await readLogChunk(runsDirectory, name, offset));
        } catch {
          return jsonResponse({ error: "Run log not found." }, { status: 404 });
        }
      }

      if (url.pathname === "/health") {
        return jsonResponse({ ok: true });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  return { server, hostname, port: configuredPort };
};

if (import.meta.main) {
  const panel = createPanelServer();
  console.log(
    `DotRelay issue runner panel listening on http://${panel.hostname}:${panel.port}`,
  );
  console.log(`Reading runner state from ${runsDirectory}`);

  const shutDown = async () => {
    await panel.server.stop(true);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutDown();
  });
  process.on("SIGTERM", () => {
    void shutDown();
  });
}
