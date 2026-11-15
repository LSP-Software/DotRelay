import { constants } from "node:os";
import type { DecodedVariable } from "@dotrelay/client";
import type { ExportFormat, ParsedArguments } from "./args";
import { type DotenvEntry, serializeDotenv } from "./dotenv";
import { refuseProcessControlNames } from "./env-safety";
import { CliError, sanitizeCliLine } from "./errors";
import { assertSafeStdout } from "./output";
import { classifyPullValues, pullVariableNames } from "./pull-values";
import type { WorkflowOptions } from "./workflow-core";
import { syncWorkflow } from "./workflow-session";

// `run`, `export`, and `list` read the Environment the same way `pull` does
// (a full verified sync, decrypted in memory), but never write a file.

type Synced = Awaited<ReturnType<typeof syncWorkflow>>;

// The Values to hand on, or a failure naming the Variables that stop it. A
// run or export with a Value missing would start a process (or print a
// configuration) that silently lacks it, so both fail before anything
// happens, like pull --no-input.
const completeEntries = (
  synced: Synced,
  action: string,
): readonly DotenvEntry[] => {
  const groups = classifyPullValues(
    synced.variables,
    synced.workflow.publicationContext.actorUserId,
  );
  if (groups.unreadable.length > 0) {
    const names = pullVariableNames(groups.unreadable);
    throw new CliError(
      "incomplete-export",
      `${names} cannot be decrypted on this Device, so nothing was ${action}. Run dotrelay device recover if this Device is locked; otherwise the Value belongs to another Member, who must set it in their own dotenv file.`,
      {
        missingCount: groups.unreadable.length,
        variableNames: names.slice(0, 512),
      },
      "missing_values",
    );
  }
  if (groups.requiredMissing.length > 0) {
    const names = pullVariableNames(groups.requiredMissing);
    throw new CliError(
      "incomplete-export",
      `${names} are required and have no value, so nothing was ${action}. Add your values for them to a dotenv file and run dotrelay push.`,
      {
        missingCount: groups.requiredMissing.length,
        variableNames: names.slice(0, 512),
      },
      "missing_values",
    );
  }
  return groups.present.map((variable) => ({
    name: variable.name,
    value: variable.value ?? "",
  }));
};

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

export const formatEntries = (
  entries: readonly DotenvEntry[],
  format: ExportFormat,
  allowedNames: readonly string[] = [],
): string => {
  // serializeDotenv validates names and duplicates for every format, so a
  // JSON or shell export can never carry a name a dotenv file would reject.
  const dotenv = serializeDotenv(entries);
  if (format === "dotenv") return dotenv;
  if (format === "json")
    return `${JSON.stringify(
      Object.fromEntries(entries.map(({ name, value }) => [name, value])),
      null,
      2,
    )}\n`;
  // Shell statements are evaluated, so a Variable that controls how the
  // shell or the programs it starts behave needs the user's explicit name.
  refuseProcessControlNames(
    entries.map(({ name }) => name),
    allowedNames,
    "printed",
  );
  return entries
    .map(({ name, value }) => `export ${name}=${shellQuote(value)}\n`)
    .join("");
};

export const exportEnvironment = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
): Promise<{ stdout: string }> => {
  // Refuse a terminal before anything is decrypted.
  assertSafeStdout({
    requested: true,
    terminal: options.stdoutIsTerminal,
    reveal: parsed.reveal,
  });
  const synced = await syncWorkflow(options, parsed);
  return {
    stdout: formatEntries(
      completeEntries(synced, "printed"),
      parsed.format ?? "dotenv",
      parsed.allowedEnvironmentNames,
    ),
  };
};

const valueState = (
  variable: DecodedVariable,
  actorUserId: string | undefined,
): "set" | "missing" | "unreadable" | "optional" => {
  const groups = classifyPullValues([variable], actorUserId);
  if (groups.present.length > 0) return "set";
  if (groups.unreadable.length > 0) return "unreadable";
  if (groups.requiredMissing.length > 0) return "missing";
  return "optional";
};

const stateLabel = {
  set: "value set",
  missing: "required, no value",
  unreadable: "cannot be decrypted here",
  optional: "optional, no value",
} as const;

export const listEnvironmentVariables = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
): Promise<Record<string, unknown>> => {
  const synced = await syncWorkflow(options, parsed);
  const actorUserId = synced.workflow.publicationContext.actorUserId;
  const variables = synced.variables
    .filter((variable) => !variable.tombstone)
    .map((variable) => ({
      name: variable.name,
      ownership:
        variable.ownership === "USER_DEFINED_VALUE"
          ? ("user-defined" as const)
          : ("shared" as const),
      required: variable.required,
      state: valueState(variable, actorUserId),
    }));
  const width = Math.max(
    4,
    ...variables.map((variable) => variable.name.length),
  );
  const lines = variables.map(
    (variable) =>
      `  ${variable.name.padEnd(width)}  ${variable.ownership.padEnd(12)}  ${stateLabel[variable.state]}`,
  );
  return {
    environmentId: synced.page.environmentId,
    variables,
    ...(parsed.json
      ? {}
      : {
          stdout:
            variables.length === 0
              ? "This Environment has no Variables yet. Publish some with dotrelay push.\n"
              : `${lines.join("\n")}\n`,
        }),
  };
};

export type ChildProcessRunner = (
  argv: readonly string[],
  environment: Readonly<Record<string, string>>,
) => Promise<number>;

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

// Starts the command with inherited stdio and the given environment. Signals
// this process receives are passed on so the command decides how to stop;
// the result is its exit code, or 128 + the signal number when a signal
// ended it, as a shell reports it.
export const spawnChildProcess: ChildProcessRunner = async (
  argv,
  environment,
) => {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([...argv], {
      env: { ...environment },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch {
    throw new CliError(
      "local-io",
      `could not start ${JSON.stringify((argv[0] ?? "").slice(0, 128))}; check that the command exists and is executable`,
      {},
      "command_start_failed",
    );
  }
  const handlers = FORWARDED_SIGNALS.map((signal) => {
    const handler = () => {
      child.kill(signal);
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  try {
    const exitCode = await child.exited;
    const signal = child.signalCode;
    if (signal) {
      const number =
        constants.signals[signal as keyof typeof constants.signals];
      return typeof number === "number" ? 128 + number : 1;
    }
    return exitCode;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
};

// The child's environment: the caller's own variables overlaid with the
// Environment's Values. A Value whose name controls how the command, its
// loader, its interpreter, or a shell starts is refused unless the user
// named it with --allow-env, because any Member can publish one.
export const childEnvironment = (
  base: Readonly<Record<string, string | undefined>>,
  entries: readonly DotenvEntry[],
  allowedNames: readonly string[],
): Record<string, string> => {
  // Validates the names the same way an exported file would.
  serializeDotenv(entries);
  refuseProcessControlNames(
    entries.map(({ name }) => name),
    allowedNames,
    "started",
  );
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(base))
    if (value !== undefined) environment[name] = value;
  for (const { name, value } of entries) environment[name] = value;
  return environment;
};

export const runWithEnvironment = async (
  options: WorkflowOptions,
  parsed: ParsedArguments,
  runner: ChildProcessRunner = spawnChildProcess,
): Promise<number> => {
  const synced = await syncWorkflow(options, parsed);
  const entries = completeEntries(synced, "started");
  return runner(
    parsed.positionals,
    childEnvironment(process.env, entries, parsed.allowedEnvironmentNames),
  );
};
