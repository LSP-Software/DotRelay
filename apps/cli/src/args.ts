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
  "team",
  "history",
  "rollback",
  "run",
  "export",
  "list",
  "account",
] as const;

export type CommandName = (typeof COMMANDS)[number];

export const EXPORT_FORMATS = ["dotenv", "json", "shell"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export type ParsedArguments = Readonly<{
  readonly command: CommandName;
  readonly subcommand?: string;
  readonly positionals: readonly string[];
  readonly profile?: string;
  readonly environment?: string;
  readonly output?: string;
  readonly from?: string;
  readonly recoveryCodeFile?: string;
  readonly transfer?: string;
  readonly to?: string;
  readonly wrapperId?: string;
  readonly team?: string;
  readonly name?: string;
  readonly remote?: string;
  readonly limit?: number;
  readonly format?: ExportFormat;
  readonly classifications: Readonly<Record<string, "shared" | "user-defined">>;
  /** Variable references: operator-visible names or stable Variable ids. */
  readonly variableReferences: readonly string[];
  /** Process-control Variable names `run` and the shell export may pass on. */
  readonly allowedEnvironmentNames: readonly string[];
  readonly noOpen: boolean;
  readonly noInput: boolean;
  readonly force: boolean;
  readonly discardLocal: boolean;
  readonly json: boolean;
  readonly debug: boolean;
  readonly stdout: boolean;
  readonly reveal: boolean;
  readonly fingerprints: boolean;
  /**
   * The account fingerprint the user compared out of band, which `team
   * trust` and `team share-keys` require before confirming an identity
   * without a terminal (ADR 0022, ADR 0023).
   */
  readonly fingerprint?: string;
}>;

type MutableArguments = {
  command?: CommandName;
  subcommand?: string;
  positionals: string[];
  profile?: string;
  environment?: string;
  output?: string;
  from?: string;
  recoveryCodeFile?: string;
  transfer?: string;
  to?: string;
  wrapperId?: string;
  team?: string;
  name?: string;
  remote?: string;
  limit?: string | number;
  format?: string;
  classifications: Record<string, "shared" | "user-defined">;
  variableReferences: string[];
  allowedEnvironmentNames: string[];
  noOpen: boolean;
  noInput: boolean;
  force: boolean;
  discardLocal: boolean;
  json: boolean;
  debug: boolean;
  stdout: boolean;
  reveal: boolean;
  fingerprints: boolean;
  fingerprint?: string;
};

const valueFlags = new Set([
  "--profile",
  "--environment",
  "--output",
  "--from",
  "--recovery-code-file",
  "--transfer",
  "--to",
  "--wrapper-id",
  "--team",
  "--name",
  "--remote",
  "--limit",
  "--classify",
  "--variable",
  "--format",
  "--allow-env",
  "--fingerprint",
]);

const forbiddenFlags = new Set([
  "--insecure",
  "--token",
  "--access-token",
  "--device-key",
  "--credentials",
]);

// The tokens DotRelay itself reads: everything before a bare --. What
// follows belongs to the command `dotrelay run` starts, so its flags (even
// --help or --insecure) are never interpreted here.
export const ownArguments = (args: readonly string[]): readonly string[] => {
  const separator = args.indexOf("--");
  return separator < 0 ? args : args.slice(0, separator);
};

export const rejectForbiddenFlags = (args: readonly string[]): void => {
  for (const token of ownArguments(args)) {
    const flag = token.includes("=")
      ? token.slice(0, token.indexOf("="))
      : token;
    if (forbiddenFlags.has(flag))
      throw new CliInvocationError(`DotRelay doesn't accept ${flag}.`);
  }
};

// A message, then the command's usage on its own line when there is one.
const withUsage = (message: string, usage: string | undefined): string =>
  usage ? `${message}\nUsage: ${usage}` : message;

const assignValue = (parsed: MutableArguments, flag: string, value: string) => {
  if (flag === "--profile") parsed.profile = value;
  else if (flag === "--environment") parsed.environment = value;
  else if (flag === "--output") parsed.output = value;
  else if (flag === "--from") parsed.from = value;
  else if (flag === "--recovery-code-file") parsed.recoveryCodeFile = value;
  else if (flag === "--transfer") parsed.transfer = value;
  else if (flag === "--to") parsed.to = value;
  else if (flag === "--wrapper-id") parsed.wrapperId = value;
  else if (flag === "--team") parsed.team = value;
  else if (flag === "--name") parsed.name = value;
  else if (flag === "--remote") parsed.remote = value;
  else if (flag === "--format") parsed.format = value;
  else if (flag === "--limit") {
    parsed.limit = value;
  } else if (flag === "--classify") {
    const separator = value.indexOf("=");
    const name = separator < 1 ? "" : value.slice(0, separator);
    const classification = separator < 1 ? "" : value.slice(separator + 1);
    const usage = usageFor(parsed.command, parsed.subcommand);
    const invalid = withUsage(
      "--classify takes NAME=shared or NAME=user-defined.",
      usage,
    );
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new CliInvocationError(invalid);
    if (classification !== "shared" && classification !== "user-defined")
      throw new CliInvocationError(invalid);
    parsed.classifications[name] = classification;
  } else if (flag === "--variable") {
    // The reference may be the operator-visible Variable name or the stable
    // Variable id; names are resolved against the live Manifest after the
    // Environment sync, where only an id can be validated up front.
    parsed.variableReferences.push(value);
  } else if (flag === "--allow-env") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      const usage = usageFor(parsed.command, parsed.subcommand);
      throw new CliInvocationError(
        withUsage(
          "--allow-env takes a variable name, such as --allow-env NODE_OPTIONS.",
          usage,
        ),
      );
    }
    parsed.allowedEnvironmentNames.push(value);
  } else if (flag === "--fingerprint") {
    // Spaces are allowed so the fingerprint can be pasted as shown.
    const fingerprint = value.replaceAll(/\s+/g, "").toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(fingerprint)) {
      const usage = usageFor(parsed.command, parsed.subcommand);
      throw new CliInvocationError(
        withUsage(
          "--fingerprint takes the 40 hex digits of an account fingerprint.",
          usage,
        ),
      );
    }
    parsed.fingerprint = fingerprint;
  }
};

export const FLAG_KEYS = [
  "profile",
  "environment",
  "output",
  "from",
  "recoveryCodeFile",
  "transfer",
  "to",
  "wrapperId",
  "team",
  "name",
  "remote",
  "limit",
  "classify",
  "variable",
  "format",
  "allowEnv",
  "noOpen",
  "noInput",
  "force",
  "discardLocal",
  "json",
  "reveal",
  "stdout",
  "fingerprints",
  "fingerprint",
] as const;

export type FlagKey = (typeof FLAG_KEYS)[number];

export const FLAG_TOKENS: Record<FlagKey, string> = {
  profile: "--profile",
  environment: "--environment",
  output: "--output",
  from: "--from",
  recoveryCodeFile: "--recovery-code-file",
  transfer: "--transfer",
  to: "--to",
  wrapperId: "--wrapper-id",
  team: "--team",
  name: "--name",
  remote: "--remote",
  limit: "--limit",
  classify: "--classify",
  variable: "--variable",
  format: "--format",
  allowEnv: "--allow-env",
  noOpen: "--no-open",
  noInput: "--no-input",
  force: "--force",
  discardLocal: "--discard-local",
  json: "--json",
  reveal: "--reveal",
  stdout: "--stdout",
  fingerprints: "--fingerprints",
  fingerprint: "--fingerprint",
};

export const USAGE: Record<string, string> = {
  setup: "dotrelay setup [<origin>]",
  login: "dotrelay login",
  logout: "dotrelay logout",
  init: "dotrelay init [<environment-id-or-label>]",
  push: "dotrelay push",
  pull: "dotrelay pull",
  diff: "dotrelay diff",
  status: "dotrelay status",
  context: "dotrelay context",
  "context reselect": "dotrelay context reselect",
  history: "dotrelay history",
  rollback:
    "dotrelay rollback <revision-id-or-ordinal> --variable <variable-name-or-id>…",
  help: "dotrelay help",
  run: "dotrelay run -- <command> [<argument>…]",
  export: "dotrelay export | --format <dotenv|json|shell>",
  list: "dotrelay list",
  "profile add": "dotrelay profile add <name> <origin>",
  "profile rebind": "dotrelay profile rebind <name> <origin>",
  "profile use": "dotrelay profile use <name>",
  "profile list": "dotrelay profile list",
  "device enroll": "dotrelay device enroll",
  "device begin": "dotrelay device begin --output <file>",
  "device approve": "dotrelay device approve --from <file>",
  "device complete": "dotrelay device complete --from <file>",
  "device backup": "dotrelay device backup",
  "device recover":
    "dotrelay device recover | --transfer <transfer-code> | --recovery-code-file <path>",
  "device setup": "dotrelay device setup",
  "device transfer": "dotrelay device transfer | --to <peer-device-id>",
  "device revoke-wrapper": "dotrelay device revoke-wrapper | --wrapper-id <id>",
  "device list": "dotrelay device list",
  "project link": "dotrelay project link --team <team-id>",
  "project rotate": "dotrelay project rotate",
  "team list": "dotrelay team list",
  "team members": "dotrelay team members | --fingerprints",
  "team trust": "dotrelay team trust <user-id> | --fingerprint <fingerprint>",
  "team share-keys":
    "dotrelay team share-keys <github-login-or-user-id> | --fingerprint <fingerprint>",
  "team decline": "dotrelay team decline <invitation-id-or-team>",
  "team leave": "dotrelay team leave <team-id-or-name>",
  "account export": "dotrelay account export | --output <file>",
  "account delete": "dotrelay account delete",
  "env list": "dotrelay env list",
  "env use":
    "dotrelay env use <environment-id-or-label> | --environment <environment-id-or-label>",
  "env create": "dotrelay env create <label>",
};

// The flags each command consumes; anything parsed but not listed here is
// rejected so an invocation can never act on a flag it silently ignored.
// --debug is the one exception: it shapes diagnostics for every command.
export const FLAG_PERMISSIONS: Record<string, readonly FlagKey[]> = {
  setup: ["noOpen", "noInput", "json"],
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
    "discardLocal",
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
  "context reselect": [
    "profile",
    "environment",
    "remote",
    "noInput",
    "force",
    "json",
  ],
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
  run: ["profile", "environment", "team", "remote", "allowEnv", "noInput"],
  export: [
    "profile",
    "environment",
    "team",
    "remote",
    "format",
    "allowEnv",
    "noInput",
    "reveal",
  ],
  list: ["profile", "environment", "team", "remote", "noInput", "json"],
  "profile add": ["noInput", "json"],
  "profile rebind": ["noInput", "force", "json"],
  "profile use": ["json"],
  "profile list": ["json"],
  "device enroll": ["profile", "noInput", "json", "output"],
  "device begin": ["profile", "noInput", "json", "output"],
  "device approve": ["profile", "noInput", "json", "from"],
  "device complete": ["profile", "noInput", "json", "from"],
  "device backup": ["profile", "noInput", "json"],
  "device recover": [
    "profile",
    "noInput",
    "json",
    "recoveryCodeFile",
    "transfer",
  ],
  "device setup": ["profile", "noInput", "json"],
  "device transfer": ["profile", "noInput", "json", "to"],
  "device revoke-wrapper": ["profile", "noInput", "json", "wrapperId"],
  "device list": ["profile", "json"],
  "project link": ["profile", "team", "remote", "noInput", "json"],
  "project rotate": ["profile", "noInput", "force", "json"],
  "team list": ["profile", "json"],
  "team members": ["profile", "team", "fingerprints", "noInput", "json"],
  "team trust": ["profile", "team", "fingerprint", "noInput", "force", "json"],
  "team share-keys": [
    "profile",
    "team",
    "fingerprint",
    "noInput",
    "force",
    "json",
  ],
  "team decline": ["profile", "noInput", "force", "json"],
  "team leave": ["profile", "noInput", "force", "json"],
  "account export": ["profile", "output", "json"],
  "account delete": ["profile", "noInput", "force", "json"],
  "env list": ["profile", "json"],
  "env use": ["profile", "environment", "json"],
  "env create": ["profile", "json"],
};

// Subcommands the parser accepts under each grouped command; the help
// views and the parser share this table so the two cannot drift.
export const SUBCOMMANDS: Readonly<
  Partial<Record<CommandName, readonly string[]>>
> = {
  profile: ["add", "rebind", "use", "list"],
  context: ["reselect"],
  device: [
    "enroll",
    "begin",
    "approve",
    "complete",
    "backup",
    "recover",
    "setup",
    "transfer",
    "revoke-wrapper",
    "list",
  ],
  project: ["link", "rotate"],
  team: ["list", "members", "trust", "share-keys", "decline", "leave"],
  env: ["list", "use", "create"],
  account: ["export", "delete"],
};

// The usage line for a complete "command [subcommand]" label; the help
// renderers and the error messages below share this one source of truth.
export const usageForLabel = (label: string): string =>
  USAGE[label] ?? `dotrelay ${label}`;

const usageFor = (
  command: CommandName | undefined,
  subcommand?: string,
): string | undefined => {
  if (!command) return undefined;
  return usageForLabel(`${command}${subcommand ? ` ${subcommand}` : ""}`);
};

const flagPresent = (parsed: MutableArguments, key: FlagKey): boolean => {
  if (key === "classify") return Object.keys(parsed.classifications).length > 0;
  if (key === "variable") return parsed.variableReferences.length > 0;
  if (key === "allowEnv") return parsed.allowedEnvironmentNames.length > 0;
  return Boolean(parsed[key]);
};

// What a command's arguments are, in words, for "dotrelay x needs ...".
const ARGUMENT_NOUNS: Readonly<Record<string, string>> = {
  setup: "the server's address",
  "profile add": "a profile name and the server's address",
  "profile rebind": "a profile name and the server's address",
  "profile use": "a profile name",
  "team trust": "the member's user id",
  "team share-keys": "the member's GitHub login or user id",
  "team decline": "the invitation id or the team",
  "team leave": "the team's id or name",
  "env use": "an environment id or label",
  "env create": "a label for the new environment",
  rollback: "the revision to roll back to",
};

// The sentence for the wrong number of arguments: what is missing, or
// which arguments it doesn't take.
const describeArgumentMismatch = (
  label: string,
  expected: number | readonly number[],
  received: readonly string[],
): string => {
  const counts = Array.isArray(expected) ? expected : [expected];
  const most = Math.max(...counts);
  if (received.length < Math.min(...counts))
    return `dotrelay ${label} needs ${ARGUMENT_NOUNS[label] ?? "an argument"}.`;
  const extra = received.slice(most);
  const noun = extra.length === 1 ? "argument" : "arguments";
  return most === 0
    ? `dotrelay ${label} doesn't take the ${noun} ${extra.join(" ")}.`
    : `dotrelay ${label} doesn't take the extra ${noun} ${extra.join(" ")}.`;
};

const validateCommand = (parsed: MutableArguments) => {
  const command = parsed.command;
  if (!command)
    throw new CliInvocationError(
      "Name a command to run. Run dotrelay help to see them.",
    );
  const label = `${command}${parsed.subcommand ? ` ${parsed.subcommand}` : ""}`;
  const usage = usageForLabel(label);
  const allowed = SUBCOMMANDS[command];
  const subcommandOptional = command === "context";
  // An unknown or missing subcommand has no usage line of its own, so the
  // error names the group's subcommands and its help instead of inventing
  // a usage line for a command that does not exist.
  if (allowed && !subcommandOptional && !parsed.subcommand)
    throw new CliInvocationError(
      withUsage(
        `dotrelay ${command} needs a subcommand: ${allowed.join(", ")}.`,
        `dotrelay ${command} <subcommand>`,
      ),
    );
  if (allowed && parsed.subcommand && !allowed.includes(parsed.subcommand))
    throw new CliInvocationError(
      withUsage(
        `dotrelay ${command} has no ${parsed.subcommand} subcommand. Choose one of: ${allowed.join(", ")}.`,
        `dotrelay ${command} <subcommand>`,
      ),
    );
  if (!allowed && parsed.subcommand)
    throw new CliInvocationError(
      withUsage(`dotrelay ${command} doesn't take a subcommand.`, usage),
    );
  if (
    command === "env" &&
    parsed.subcommand === "use" &&
    parsed.environment &&
    parsed.positionals.length > 0
  )
    throw new CliInvocationError(
      withUsage(
        "Give the environment either as an argument or with --environment, not both.",
        usage,
      ),
    );
  if (
    command === "init" &&
    parsed.environment &&
    parsed.positionals.length === 1
  )
    throw new CliInvocationError(
      withUsage(
        "Give the environment either as an argument or with --environment, not both.",
        usage,
      ),
    );
  const allowedFlags = FLAG_PERMISSIONS[label] ?? [];
  for (const key of FLAG_KEYS) {
    if (!flagPresent(parsed, key)) continue;
    if (key === "name")
      throw new CliInvocationError(
        withUsage("DotRelay has no --name option.", usage),
      );
    if (!allowedFlags.includes(key))
      throw new CliInvocationError(
        withUsage(
          `${FLAG_TOKENS[key]} doesn't work with dotrelay ${label}.`,
          usage,
        ),
      );
  }
  if (
    parsed.format !== undefined &&
    !EXPORT_FORMATS.includes(parsed.format as ExportFormat)
  )
    throw new CliInvocationError(
      withUsage(
        `--format must be ${EXPORT_FORMATS.slice(0, -1).join(", ")} or ${EXPORT_FORMATS[EXPORT_FORMATS.length - 1]}.`,
        usage,
      ),
    );
  if (parsed.limit !== undefined) {
    const limit = Number(parsed.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
      throw new CliInvocationError(
        withUsage("--limit must be a whole number from 1 to 256.", usage),
      );
    parsed.limit = limit;
  }
  if (command === "pull") {
    if (parsed.stdout && parsed.output)
      throw new CliInvocationError(
        withUsage(
          "Use --stdout to print the values or --output <file> to write them to a file, not both.",
          usage,
        ),
      );
    if (parsed.stdout && parsed.json)
      throw new CliInvocationError(
        withUsage(
          "--stdout doesn't work with --json, because values never appear in JSON output. To write a file and get JSON, use dotrelay pull --output <file> --json.",
          usage,
        ),
      );
  }
  if (command === "project" && parsed.subcommand === "link" && !parsed.team)
    throw new CliInvocationError(
      withUsage("dotrelay project link needs --team <team-id>.", usage),
    );
  const positionalCounts: Partial<
    Record<CommandName, number | readonly number[]>
  > = {
    profile:
      parsed.subcommand === "add" || parsed.subcommand === "rebind"
        ? 2
        : parsed.subcommand === "use"
          ? 1
          : 0,
    device: 0,
    project: 0,
    team:
      parsed.subcommand === "trust" ||
      parsed.subcommand === "share-keys" ||
      parsed.subcommand === "decline" ||
      parsed.subcommand === "leave"
        ? 1
        : 0,
    account: 0,
    env:
      parsed.subcommand === "list"
        ? 0
        : parsed.subcommand === "use" && parsed.environment
          ? 0
          : 1,
    init: [0, 1],
    setup: [0, 1],
    login: 0,
    logout: 0,
    push: 0,
    pull: 0,
    status: 0,
    context: 0,
    history: 0,
    // help takes the command it documents: `help rollback`, or a nested
    // command such as `help device recover`.
    help: [0, 1, 2],
    diff: 0,
    // Interactively the target Revision can be chosen from the rendered
    // history instead of named on the command line; automation must name it.
    rollback: parsed.noInput ? 1 : [0, 1],
    export: 0,
    list: 0,
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
        ? ` To choose an environment, use --environment ${parsed.positionals[0]}.`
        : "";
      throw new CliInvocationError(
        withUsage(
          `${describeArgumentMismatch(label, expected, parsed.positionals)}${correction}`,
          usage,
        ),
      );
    }
  }
  if (command === "run" && parsed.positionals.length === 0)
    throw new CliInvocationError(
      withUsage(
        "Put the command to start after --, such as dotrelay run -- npm start.",
        usage,
      ),
    );
  if (
    command === "device" &&
    ["approve", "complete"].includes(parsed.subcommand ?? "") &&
    !parsed.from
  )
    throw new CliInvocationError(
      withUsage(
        `dotrelay device ${parsed.subcommand} needs --from <file>.`,
        usage,
      ),
    );
  if (command === "device" && parsed.subcommand === "recover") {
    const hasCodeFile = parsed.recoveryCodeFile !== undefined;
    const hasTransfer = parsed.transfer !== undefined;
    if (hasCodeFile && hasTransfer)
      throw new CliInvocationError(
        withUsage(
          "Use --recovery-code-file <path> or --transfer <transfer-code>, not both.",
          usage,
        ),
      );
  }
  if (
    command === "device" &&
    parsed.subcommand === "transfer" &&
    parsed.noInput &&
    !parsed.to
  )
    throw new CliInvocationError(
      withUsage(
        "With --no-input, dotrelay device transfer needs --to <peer-device-id>.",
        usage,
      ),
    );
  if (
    command === "device" &&
    parsed.subcommand === "revoke-wrapper" &&
    parsed.noInput &&
    !parsed.wrapperId
  )
    throw new CliInvocationError(
      withUsage(
        "With --no-input, dotrelay device revoke-wrapper needs --wrapper-id <id>.",
        usage,
      ),
    );
  // Interactively the Variables to roll back are chosen by name from the
  // live Manifest; automation must name at least one.
  if (
    command === "rollback" &&
    parsed.noInput &&
    parsed.variableReferences.length === 0
  )
    throw new CliInvocationError(
      withUsage(
        "With --no-input, dotrelay rollback needs at least one --variable <variable-name-or-id>.",
        usage,
      ),
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
    discardLocal: false,
    json: false,
    debug: false,
    stdout: false,
    reveal: false,
    fingerprints: false,
    classifications: {},
    variableReferences: [],
    allowedEnvironmentNames: [],
  };
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === undefined) break;
    if (token === "--") {
      parsed.positionals.push(...args.slice(index + 1));
      break;
    }
    // Short aliases: -h and -v are routed by run() before parsing, and -o is
    // the conventional spelling of --output.
    if (token === "-h" || token === "-v") {
      index += 1;
      continue;
    }
    if (token === "-o") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("-")) {
        const usage = usageFor(parsed.command, parsed.subcommand);
        throw new CliInvocationError(withUsage("-o needs a value.", usage));
      }
      assignValue(parsed, "--output", value);
      index += 2;
      continue;
    }
    if (/^-[A-Za-z]/.test(token)) {
      const usage = usageFor(parsed.command, parsed.subcommand);
      throw new CliInvocationError(
        withUsage(
          `DotRelay has no ${token} option. Options start with two dashes, such as --output.`,
          usage,
        ),
      );
    }
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      const flag = equals < 0 ? token : token.slice(0, equals);
      if (forbiddenFlags.has(flag))
        throw new CliInvocationError(`DotRelay doesn't accept ${flag}.`);
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
            withUsage(`${flag} needs a value.`, usage),
          );
        }
        assignValue(parsed, flag, value);
      } else if (flag === "--no-open") parsed.noOpen = true;
      else if (flag === "--no-input") parsed.noInput = true;
      else if (flag === "--force") parsed.force = true;
      else if (flag === "--discard-local") parsed.discardLocal = true;
      else if (flag === "--json") parsed.json = true;
      else if (flag === "--debug") parsed.debug = true;
      else if (flag === "--stdout") parsed.stdout = true;
      else if (flag === "--reveal") parsed.reveal = true;
      else if (flag === "--fingerprints") parsed.fingerprints = true;
      else {
        const usage = usageFor(parsed.command, parsed.subcommand);
        throw new CliInvocationError(
          withUsage(`DotRelay has no ${flag} option.`, usage),
        );
      }
    } else if (!parsed.command) {
      if (!COMMANDS.includes(token as CommandName))
        throw new CliInvocationError(
          `DotRelay has no ${token} command. Run dotrelay help to see them.`,
        );
      parsed.command = token as CommandName;
    } else if (parsed.command === "run") {
      // The child command must follow --, so its own flags can never be
      // read as DotRelay flags.
      throw new CliInvocationError(
        withUsage(
          "Put the command to start after --, such as dotrelay run -- npm start.",
          usageForLabel("run"),
        ),
      );
    } else if (
      (parsed.command === "profile" ||
        parsed.command === "device" ||
        parsed.command === "project" ||
        parsed.command === "team" ||
        parsed.command === "account" ||
        parsed.command === "env" ||
        parsed.command === "context") &&
      !parsed.subcommand
    ) {
      parsed.subcommand = token;
    } else parsed.positionals.push(token);
    index += 1;
  }
  validateCommand(parsed);
  if (parsed.stdout && (options.stdoutIsTerminal ?? false) && !parsed.reveal)
    throw new CliInvocationError(
      withUsage(
        "--stdout would print the values in your terminal. Add --reveal to allow that.",
        usageFor(parsed.command, parsed.subcommand) ?? "dotrelay pull",
      ),
    );
  return Object.freeze({
    ...parsed,
    command: parsed.command,
    positionals: Object.freeze(parsed.positionals),
    classifications: Object.freeze({ ...parsed.classifications }),
    variableReferences: Object.freeze([...parsed.variableReferences]),
    allowedEnvironmentNames: Object.freeze([...parsed.allowedEnvironmentNames]),
  }) as ParsedArguments;
};
