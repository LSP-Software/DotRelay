import { CliInvocationError } from "./errors";

export { CliInvocationError } from "./errors";

export const COMMANDS = [
  "setup",
  "login",
  "logout",
  "init",
  "push",
  "pull",
  "diff",
  "status",
  "help",
  "profile",
  "device",
  "context",
  "project",
  "env",
  "history",
  "rollback",
] as const;

export type CommandName = (typeof COMMANDS)[number];

export type ParsedArguments = Readonly<{
  readonly command: CommandName;
  readonly subcommand?: string;
  readonly positionals: readonly string[];
  readonly profile?: string;
  readonly acceptProfile?: string;
  readonly environment?: string;
  readonly output?: string;
  readonly from?: string;
  readonly team?: string;
  readonly name?: string;
  readonly remote?: string;
  readonly limit?: number;
  readonly classifications: Readonly<Record<string, "shared" | "user-defined">>;
  readonly variableIds: readonly string[];
  readonly noOpen: boolean;
  readonly noInput: boolean;
  readonly force: boolean;
  readonly json: boolean;
  readonly debug: boolean;
  readonly stdout: boolean;
  readonly reveal: boolean;
}>;

type MutableArguments = {
  command?: CommandName;
  subcommand?: string;
  positionals: string[];
  profile?: string;
  acceptProfile?: string;
  environment?: string;
  output?: string;
  from?: string;
  team?: string;
  name?: string;
  remote?: string;
  limit?: string | number;
  classifications: Record<string, "shared" | "user-defined">;
  variableIds: string[];
  noOpen: boolean;
  noInput: boolean;
  force: boolean;
  json: boolean;
  debug: boolean;
  stdout: boolean;
  reveal: boolean;
};

const valueFlags = new Set([
  "--profile",
  "--accept-profile",
  "--environment",
  "--output",
  "--from",
  "--team",
  "--name",
  "--remote",
  "--limit",
  "--classify",
  "--variable",
]);

const forbiddenFlags = new Set([
  "--insecure",
  "--token",
  "--access-token",
  "--device-key",
  "--credentials",
]);

export const rejectForbiddenFlags = (args: readonly string[]): void => {
  for (const token of args) {
    const flag = token.includes("=")
      ? token.slice(0, token.indexOf("="))
      : token;
    if (forbiddenFlags.has(flag))
      throw new CliInvocationError(`${flag} is not supported`);
  }
};

const assignValue = (parsed: MutableArguments, flag: string, value: string) => {
  if (flag === "--profile") parsed.profile = value;
  else if (flag === "--accept-profile") parsed.acceptProfile = value;
  else if (flag === "--environment") parsed.environment = value;
  else if (flag === "--output") parsed.output = value;
  else if (flag === "--from") parsed.from = value;
  else if (flag === "--team") parsed.team = value;
  else if (flag === "--name") parsed.name = value;
  else if (flag === "--remote") parsed.remote = value;
  else if (flag === "--limit") {
    parsed.limit = value;
  } else if (flag === "--classify") {
    const separator = value.indexOf("=");
    const name = separator < 1 ? "" : value.slice(0, separator);
    const classification = separator < 1 ? "" : value.slice(separator + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new CliInvocationError(
        "--classify requires NAME=shared or NAME=user-defined",
      );
    if (classification !== "shared" && classification !== "user-defined")
      throw new CliInvocationError(
        "--classify requires NAME=shared or NAME=user-defined",
      );
    parsed.classifications[name] = classification;
  } else if (flag === "--variable") {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      )
    )
      throw new CliInvocationError(
        "--variable requires a Revision Variable id",
      );
    parsed.variableIds.push(value.toLowerCase());
  }
};

const FLAG_KEYS = [
  "profile",
  "acceptProfile",
  "environment",
  "output",
  "from",
  "team",
  "name",
  "remote",
  "limit",
  "classify",
  "variable",
  "noOpen",
  "noInput",
  "force",
  "json",
  "reveal",
  "stdout",
] as const;

type FlagKey = (typeof FLAG_KEYS)[number];

const FLAG_TOKENS: Record<FlagKey, string> = {
  profile: "--profile",
  acceptProfile: "--accept-profile",
  environment: "--environment",
  output: "--output",
  from: "--from",
  team: "--team",
  name: "--name",
  remote: "--remote",
  limit: "--limit",
  classify: "--classify",
  variable: "--variable",
  noOpen: "--no-open",
  noInput: "--no-input",
  force: "--force",
  json: "--json",
  reveal: "--reveal",
  stdout: "--stdout",
};

const USAGE: Record<string, string> = {
  setup: "dotrelay setup <origin>",
  login: "dotrelay login",
  logout: "dotrelay logout",
  init: "dotrelay init [<environment-id-or-label>]",
  push: "dotrelay push",
  pull: "dotrelay pull",
  diff: "dotrelay diff",
  status: "dotrelay status",
  context: "dotrelay context",
  history: "dotrelay history",
  rollback: "dotrelay rollback <revision-id> --variable <variable-id>",
  help: "dotrelay help",
  "profile add": "dotrelay profile add <name> <origin>",
  "profile use": "dotrelay profile use <name>",
  "profile list": "dotrelay profile list",
  "device enroll": "dotrelay device enroll",
  "device begin": "dotrelay device begin --output <file>",
  "device approve": "dotrelay device approve --from <file>",
  "device complete": "dotrelay device complete --from <file>",
  "device backup": "dotrelay device backup --output <file>",
  "device recover": "dotrelay device recover --from <file>",
  "project link": "dotrelay project link --team <team-id>",
  "env use":
    "dotrelay env use <environment-id-or-label> | --environment <environment-id-or-label>",
};

// The flags each command consumes; anything parsed but not listed here is
// rejected so an invocation can never act on a flag it silently ignored.
// --debug is the one exception: it shapes diagnostics for every command.
const FLAG_PERMISSIONS: Record<string, readonly FlagKey[]> = {
  setup: ["acceptProfile", "noOpen", "noInput", "json"],
  login: ["profile", "noOpen", "noInput", "json"],
  logout: ["profile", "json"],
  init: [
    "profile",
    "environment",
    "from",
    "team",
    "remote",
    "noInput",
    "force",
    "json",
    "limit",
    "reveal",
    "classify",
  ],
  push: [
    "profile",
    "environment",
    "from",
    "team",
    "remote",
    "noInput",
    "force",
    "json",
    "limit",
    "reveal",
    "classify",
  ],
  pull: [
    "profile",
    "environment",
    "team",
    "remote",
    "output",
    "stdout",
    "noInput",
    "force",
    "json",
    "limit",
    "reveal",
  ],
  diff: [
    "profile",
    "environment",
    "team",
    "from",
    "remote",
    "noInput",
    "json",
    "limit",
    "reveal",
  ],
  status: ["profile", "json"],
  context: ["profile", "environment", "remote", "noInput", "json"],
  history: [
    "profile",
    "environment",
    "team",
    "remote",
    "noInput",
    "json",
    "limit",
  ],
  rollback: [
    "profile",
    "environment",
    "team",
    "remote",
    "variable",
    "noInput",
    "json",
    "limit",
    "reveal",
  ],
  help: [],
  "profile add": ["acceptProfile", "noInput", "json"],
  "profile use": ["json"],
  "profile list": ["json"],
  "device enroll": ["profile", "noInput", "json", "output"],
  "device begin": ["profile", "noInput", "json", "output"],
  "device approve": ["profile", "noInput", "json", "from"],
  "device complete": ["profile", "noInput", "json", "from"],
  "device backup": ["profile", "noInput", "force", "json", "output"],
  "device recover": ["profile", "noInput", "json", "from"],
  "project link": ["profile", "team", "remote", "noInput", "json"],
  "env use": ["profile", "environment", "json"],
};

const usageFor = (
  command: CommandName | undefined,
  subcommand?: string,
): string | undefined => {
  if (!command) return undefined;
  const label = `${command}${subcommand ? ` ${subcommand}` : ""}`;
  return USAGE[label] ?? `dotrelay ${label}`;
};

const flagPresent = (parsed: MutableArguments, key: FlagKey): boolean => {
  if (key === "classify") return Object.keys(parsed.classifications).length > 0;
  if (key === "variable") return parsed.variableIds.length > 0;
  return Boolean(parsed[key]);
};

const describePositionals = (expected: number | readonly number[]): string =>
  Array.isArray(expected)
    ? "zero or one positional arguments"
    : expected === 0
      ? "no positional arguments"
      : expected === 1
        ? "exactly one positional argument"
        : `${expected} positional arguments`;

const validateCommand = (parsed: MutableArguments) => {
  const command = parsed.command;
  if (!command) throw new CliInvocationError("a command is required");
  const label = `${command}${parsed.subcommand ? ` ${parsed.subcommand}` : ""}`;
  const usage = USAGE[label] ?? `dotrelay ${label}`;
  const expectedSubcommands: Partial<Record<CommandName, readonly string[]>> = {
    profile: ["add", "use", "list"],
    device: ["enroll", "begin", "approve", "complete", "backup", "recover"],
    project: ["link"],
    env: ["use"],
  };
  const allowed = expectedSubcommands[command];
  if (allowed && (!parsed.subcommand || !allowed.includes(parsed.subcommand)))
    throw new CliInvocationError(
      `${command} requires one of: ${allowed.join(", ")}`,
    );
  if (!allowed && parsed.subcommand)
    throw new CliInvocationError(`${command} does not accept a subcommand`);
  if (
    command === "env" &&
    parsed.subcommand === "use" &&
    parsed.environment &&
    parsed.positionals.length > 0
  )
    throw new CliInvocationError(
      `env use accepts an Environment id or label either as an argument or with --environment, not both; usage: ${usage}`,
    );
  if (
    command === "init" &&
    parsed.environment &&
    parsed.positionals.length === 1
  )
    throw new CliInvocationError(
      `init accepts an Environment id or label either as an argument or with --environment, not both; usage: ${usage}`,
    );
  const allowedFlags = FLAG_PERMISSIONS[label] ?? [];
  for (const key of FLAG_KEYS) {
    if (!flagPresent(parsed, key)) continue;
    if (key === "name")
      throw new CliInvocationError(
        `--name is not a supported option; usage: ${usage}`,
      );
    if (!allowedFlags.includes(key))
      throw new CliInvocationError(
        `${FLAG_TOKENS[key]} is not supported by ${label}; usage: ${usage}`,
      );
  }
  if (parsed.limit !== undefined) {
    const limit = Number(parsed.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
      throw new CliInvocationError("--limit must be an integer from 1 to 256");
    parsed.limit = limit;
  }
  if (command === "pull") {
    if (parsed.stdout && parsed.output)
      throw new CliInvocationError(
        "pull --stdout and --output are mutually exclusive; use either `dotrelay pull --stdout` or `dotrelay pull --output <file>`",
      );
    if (parsed.stdout && parsed.json)
      throw new CliInvocationError(
        "pull --stdout and --json are mutually exclusive because Values never appear in JSON output; use `dotrelay pull --output <file> --json` instead",
      );
  }
  const positionalCounts: Partial<
    Record<CommandName, number | readonly number[]>
  > = {
    profile:
      parsed.subcommand === "add" ? 2 : parsed.subcommand === "use" ? 1 : 0,
    device: 0,
    project: 0,
    env: parsed.subcommand === "use" && parsed.environment ? 0 : 1,
    init: [0, 1],
    setup: 1,
    login: 0,
    logout: 0,
    push: 0,
    pull: 0,
    status: 0,
    context: 0,
    history: 0,
    help: 0,
    diff: 0,
    rollback: 1,
  };
  const expected = positionalCounts[command];
  if (expected !== undefined) {
    const valid = Array.isArray(expected)
      ? expected.includes(parsed.positionals.length)
      : parsed.positionals.length === expected;
    if (!valid) {
      const suggestEnvironment =
        expected === 0 &&
        parsed.positionals.length === 1 &&
        parsed.environment === undefined &&
        allowedFlags.includes("environment");
      const correction = suggestEnvironment
        ? `; use --environment ${parsed.positionals[0]} instead`
        : "";
      throw new CliInvocationError(
        `${label} takes ${describePositionals(expected)} but received ${parsed.positionals.length}${correction}; usage: ${usage}`,
      );
    }
  }
  if (
    command === "device" &&
    ["approve", "complete", "recover"].includes(parsed.subcommand ?? "") &&
    !parsed.from
  )
    throw new CliInvocationError(
      `device ${parsed.subcommand} requires --from <file>; usage: ${usage}`,
    );
  if (command === "device" && parsed.subcommand === "backup" && !parsed.output)
    throw new CliInvocationError(
      `device backup requires --output <file>; usage: ${usage}`,
    );
  if (command === "rollback" && parsed.variableIds.length === 0)
    throw new CliInvocationError(
      `rollback requires at least one --variable; usage: ${usage}`,
    );
};

export const parseArguments = (
  args: readonly string[],
  options: Readonly<{ readonly stdoutIsTerminal?: boolean }> = {},
): ParsedArguments => {
  const parsed: MutableArguments = {
    positionals: [],
    noOpen: false,
    noInput: false,
    force: false,
    json: false,
    debug: false,
    stdout: false,
    reveal: false,
    classifications: {},
    variableIds: [],
  };
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === undefined) break;
    if (token === "--") {
      parsed.positionals.push(...args.slice(index + 1));
      break;
    }
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      const flag = equals < 0 ? token : token.slice(0, equals);
      if (forbiddenFlags.has(flag))
        throw new CliInvocationError(`${flag} is not supported`);
      if (flag === "--help" || flag === "--version") {
        index += 1;
        continue;
      }
      if (valueFlags.has(flag)) {
        const value = equals < 0 ? args[++index] : token.slice(equals + 1);
        if (
          value === undefined ||
          value.length === 0 ||
          value.startsWith("--")
        ) {
          const usage = usageFor(parsed.command, parsed.subcommand);
          throw new CliInvocationError(
            `${flag} needs a value${usage ? `; usage: ${usage}` : ""}`,
          );
        }
        assignValue(parsed, flag, value);
      } else if (flag === "--no-open") parsed.noOpen = true;
      else if (flag === "--no-input") parsed.noInput = true;
      else if (flag === "--force") parsed.force = true;
      else if (flag === "--json") parsed.json = true;
      else if (flag === "--debug") parsed.debug = true;
      else if (flag === "--stdout") parsed.stdout = true;
      else if (flag === "--reveal") parsed.reveal = true;
      else throw new CliInvocationError(`unknown option: ${flag}`);
    } else if (!parsed.command) {
      if (!COMMANDS.includes(token as CommandName))
        throw new CliInvocationError(`unknown command: ${token}`);
      parsed.command = token as CommandName;
    } else if (
      (parsed.command === "profile" ||
        parsed.command === "device" ||
        parsed.command === "project" ||
        parsed.command === "env") &&
      !parsed.subcommand
    ) {
      parsed.subcommand = token;
    } else parsed.positionals.push(token);
    index += 1;
  }
  validateCommand(parsed);
  if (parsed.stdout && (options.stdoutIsTerminal ?? false) && !parsed.reveal)
    throw new CliInvocationError(
      "refusing to write Values to terminal stdout; add --reveal explicitly",
    );
  return Object.freeze({
    ...parsed,
    command: parsed.command,
    positionals: Object.freeze(parsed.positionals),
    classifications: Object.freeze({ ...parsed.classifications }),
    variableIds: Object.freeze([...parsed.variableIds]),
  }) as ParsedArguments;
};
