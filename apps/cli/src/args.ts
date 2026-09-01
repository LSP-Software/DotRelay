import { CliInvocationError } from "./errors";

export { CliInvocationError } from "./errors";

export const COMMANDS = [
  "profile",
  "login",
  "logout",
  "device",
  "context",
  "project",
  "env",
  "init",
  "push",
  "pull",
  "history",
  "rollback",
  "status",
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
  readonly limit?: number;
  readonly noOpen: boolean;
  readonly noInput: boolean;
  readonly json: boolean;
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
  limit?: number;
  noOpen: boolean;
  noInput: boolean;
  json: boolean;
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
  "--limit",
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
  if (value.length === 0) throw new CliInvocationError(`${flag} needs a value`);
  if (flag === "--profile") parsed.profile = value;
  else if (flag === "--accept-profile") parsed.acceptProfile = value;
  else if (flag === "--environment") parsed.environment = value;
  else if (flag === "--output") parsed.output = value;
  else if (flag === "--from") parsed.from = value;
  else if (flag === "--team") parsed.team = value;
  else if (flag === "--name") parsed.name = value;
  else if (flag === "--limit") {
    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
      throw new CliInvocationError("--limit must be an integer from 1 to 256");
    parsed.limit = limit;
  }
};

const validateCommand = (parsed: MutableArguments) => {
  const command = parsed.command;
  if (!command) throw new CliInvocationError("a command is required");
  const expectedSubcommands: Partial<Record<CommandName, readonly string[]>> = {
    profile: ["add", "use", "list"],
    device: ["enroll", "recover"],
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
  const positionalCounts: Partial<
    Record<CommandName, number | readonly number[]>
  > = {
    profile:
      parsed.subcommand === "add" ? 2 : parsed.subcommand === "use" ? 1 : 0,
    device: 0,
    project: 0,
    env: parsed.subcommand === "use" && parsed.environment ? 0 : 1,
    init: 1,
    rollback: 1,
  };
  const expected = positionalCounts[command];
  if (expected !== undefined) {
    const valid = Array.isArray(expected)
      ? expected.includes(parsed.positionals.length)
      : parsed.positionals.length === expected;
    if (!valid)
      throw new CliInvocationError(
        `${command}${parsed.subcommand ? ` ${parsed.subcommand}` : ""} has an invalid number of arguments`,
      );
  }
  if (parsed.stdout && command !== "pull")
    throw new CliInvocationError("--stdout is only valid with pull");
  if (parsed.reveal && command !== "pull")
    throw new CliInvocationError("--reveal is only valid with pull");
  if (parsed.output && command !== "pull")
    throw new CliInvocationError("--output is only valid with pull");
  if (parsed.from && !["init", "push"].includes(command))
    throw new CliInvocationError("--from is only valid with init or push");
  if (parsed.team && !(command === "project" && parsed.subcommand === "link"))
    throw new CliInvocationError("--team is only valid with project link");
  if (
    command === "env" &&
    parsed.subcommand === "use" &&
    parsed.environment &&
    parsed.positionals.length > 0
  )
    throw new CliInvocationError(
      "env use accepts an Environment id either as an argument or with --environment",
    );
  if (
    parsed.acceptProfile &&
    !(command === "profile" && parsed.subcommand === "add")
  )
    throw new CliInvocationError(
      "--accept-profile is only valid with profile add",
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
    json: false,
    stdout: false,
    reveal: false,
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
        if (value === undefined)
          throw new CliInvocationError(`${flag} needs a value`);
        assignValue(parsed, flag, value);
      } else if (flag === "--no-open") parsed.noOpen = true;
      else if (flag === "--no-input") parsed.noInput = true;
      else if (flag === "--json") parsed.json = true;
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
  if (parsed.stdout && (options.stdoutIsTerminal ?? false) && !parsed.reveal)
    throw new CliInvocationError(
      "refusing to write Values to terminal stdout; add --reveal explicitly",
    );
  validateCommand(parsed);
  return Object.freeze({
    ...parsed,
    command: parsed.command,
    positionals: Object.freeze(parsed.positionals),
  }) as ParsedArguments;
};
