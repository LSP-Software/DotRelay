import { execFileSync, spawn } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";

export const isInfrastructureError = (text: string) =>
  /cannot connect to API|could not resolve host|connection (refused|reset|timed out)|network is unreachable|TLS handshake timeout|HTTP (429|502|503|504)|rate limit exceeded|temporarily unavailable/i.test(
    text,
  );

/** Run a command with a deadline, stopping its descendants before returning. */
export const runProcess = async (
  args: string[],
  options: {
    cwd?: string | undefined;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    signal?: AbortSignal;
    live?: boolean;
    onOutput?: (data: string, stderr: boolean) => void;
  } = {},
): Promise<{
  code: number;
  output: string;
  stdout: string;
  infrastructure: boolean;
}> => {
  options.signal?.throwIfAborted();
  const executable = args[0];
  if (!executable) throw new Error("A command is required");
  const child = spawn(executable, args.slice(1), {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let stdout = "";
  let infrastructure = false;
  let timedOut = false;
  let cleanupFailed = false;
  const stop = () => {
    if (child.pid) {
      // Nested command wrappers create their own process groups. Include those
      // descendants when a whole issue times out or the controller is stopped.
      const descendants = new Set([child.pid]);
      let listing = "";
      try {
        listing = execFileSync("ps", ["-axo", "pid=,ppid="], {
          encoding: "utf8",
          timeout: 5000,
        });
      } catch {
        cleanupFailed = true;
      }
      const rows = listing
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/).map(Number));
      let changed = true;
      while (changed) {
        changed = false;
        for (const [pid, parent] of rows) {
          if (
            pid &&
            parent &&
            descendants.has(parent) &&
            !descendants.has(pid)
          ) {
            descendants.add(pid);
            changed = true;
          }
        }
      }
      for (const pid of [...descendants].reverse()) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* Not a process group leader. */
        }
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already stopped. */
      }
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeout ?? 120_000);
  options.signal?.addEventListener("abort", stop, { once: true });
  const consume = (data: string, stderr: boolean) => {
    output += data;
    if (!stderr) stdout += data;
    if (options.live) output = output.slice(-2_000_000);
    if (options.live) stdout = stdout.slice(-2_000_000);
    infrastructure ||= isInfrastructureError(output);
    options.onOutput?.(data, stderr);
    if (options.live) (stderr ? process.stderr : process.stdout).write(data);
  };
  child.stdout
    .setEncoding("utf8")
    .on("data", (data: string) => consume(data, false));
  child.stderr
    .setEncoding("utf8")
    .on("data", (data: string) => consume(data, true));
  try {
    const code = await new Promise<number>((accept, reject) => {
      child.once("error", reject);
      child.once("close", (status) => accept(status ?? 1));
    });
    if (!cleanupFailed) options.signal?.throwIfAborted();
    if (cleanupFailed) {
      output +=
        "\nProcess cleanup could not enumerate descendants. Inspect running processes before restarting.\n";
    } else if (timedOut) {
      output += `\n${args[0]} timed out; its process group was stopped.\n`;
      if (options.live)
        process.stderr.write(
          `${args[0]} timed out; its process group was stopped.\n`,
        );
    }
    return {
      code: cleanupFailed ? 70 : timedOut ? 75 : code,
      output: output.trim(),
      stdout,
      infrastructure: timedOut || (code !== 0 && infrastructure),
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
  }
};

if (import.meta.main) {
  const seconds = Number(process.argv[2]);
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || !process.argv[3]) {
    console.error(
      "Usage: run-issues-process.ts TIMEOUT_SECONDS COMMAND [ARGS...]",
    );
    process.exitCode = 1;
  } else {
    const abort = new AbortController();
    const stop = () => abort.abort(new Error("Command interrupted"));
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const result = await runProcess(process.argv.slice(3), {
        timeout: seconds * 1000,
        live: true,
        signal: abort.signal,
      });
      const { RUN_INFRA_MARKER: marker, RUN_UNSAFE_MARKER: unsafe } =
        process.env;
      if (result.code === 70 && unsafe) await writeFile(unsafe, result.output);
      if (result.infrastructure && marker)
        await writeFile(marker, "Infrastructure failure\n");
      else if (!result.code && marker)
        await unlink(marker).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      process.exitCode = result.code;
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
