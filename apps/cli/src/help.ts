import {
  COMMANDS,
  type CommandName,
  FLAG_KEYS,
  FLAG_PERMISSIONS,
  FLAG_TOKENS,
  type FlagKey,
  SUBCOMMANDS,
  usageForLabel,
} from "./args";
import { banner, bold, paint, section } from "./components";
import { CliInvocationError } from "./errors";
import { defaultOrigin } from "./version";

export type CommandHelpEntry = Readonly<{
  readonly about: string;
  readonly positional?: readonly string[];
  readonly options?: Readonly<Partial<Record<FlagKey, string>>>;
  readonly notes?: readonly string[];
  readonly examples: readonly string[];
}>;

// The per-command help data. Keys are the same command labels the parser
// uses (see USAGE and FLAG_PERMISSIONS in args.ts), so a command that exists
// for the parser must exist here and vice versa; the contract tests in
// help.test.ts keep the two in lockstep.
export const COMMAND_HELP: Readonly<Record<string, CommandHelpEntry>> = {
  setup: {
    about:
      "Trust this Server Profile, sign in, and enroll this machine. The capabilities document is fetched from the origin and verified before the profile is trusted, saved, and selected.",
    positional: [
      "<origin>  The Server Profile origin; a missing scheme defaults to https.",
    ],
    options: {
      noInput: "never prompt; requires --accept-profile <server-profile-id>",
      noOpen: "do not open the verification page in a browser",
    },
    notes: [
      "A changed profile identity or origin is never re-trusted silently; it requires a new trust decision.",
      "On a loopback host, an HTTPS endpoint that cannot be reached is retried once over plain HTTP.",
    ],
    examples: [
      "dotrelay setup relay.example",
      "dotrelay setup https://relay.example --no-input --accept-profile <server-profile-id>",
    ],
  },
  login: {
    about:
      "Sign in to the Server Profile and enroll this machine when it has no Device yet. The verification URL, user code, and code expiry are shown before the CLI starts waiting.",
    options: {
      profile:
        "Server Profile to sign in to (default: the globally selected profile)",
      noInput:
        "never prompt or open a browser; the URL, code, and expiry are shown to open manually",
    },
    examples: ["dotrelay login", "dotrelay login --profile work --no-open"],
  },
  logout: {
    about:
      "Remove the local session for the Server Profile. The session material is deleted from the credential store; the Device stays enrolled.",
    examples: ["dotrelay logout"],
  },
  init: {
    about:
      "Publish this repo's .env for the first time. When the GitHub Repository is not linked yet, init creates the missing Team, Project, and Environment; if the Environment already has a genesis Revision, init continues as push.",
    positional: [
      "<environment-id-or-label>  Optional Environment id or label to publish into (default: the saved selection, or the Project's single active Environment).",
    ],
    options: {
      from: "dotenv file to publish (default: .env)",
      classify:
        "classify a new Variable as shared or user-defined (NAME=shared|user-defined); required under --no-input for every new Variable",
      environment:
        "Environment id or label to publish into (alternative to the positional)",
      team: "Team to link the Repository into (default: the only Team, chosen interactively, or created)",
      noInput:
        "never prompt or guess; requires explicit --profile and Environment context",
      force: "approve publishing Variables that the file omits",
    },
    examples: [
      "dotrelay init",
      "dotrelay init production --classify API_URL=shared",
      "dotrelay init <environment-id>",
    ],
  },
  push: {
    about:
      "Publish changes from .env (or --from <dotenv>) to the Environment. Omitted Variables become signed tombstones, and only Variables that change are confirmed, masked by default.",
    options: {
      from: "dotenv file to publish (default: .env)",
      classify:
        "classify a new Variable as shared or user-defined (NAME=shared|user-defined); required under --no-input for every new Variable",
      environment:
        "Environment id or label to publish into (default: the saved selection, or the Project's single active Environment)",
      team: "Team to link the Repository into (default: the only Team, chosen interactively, or created)",
      noInput:
        "never prompt or guess; requires explicit --profile and Environment context",
      force: "approve publishing Variables that the file omits",
    },
    examples: [
      "dotrelay push",
      "dotrelay push --from .env --classify NEW_VARIABLE=user-defined",
      "dotrelay push --environment <environment-id>",
    ],
  },
  pull: {
    about:
      "Write decrypted Values to .env by default. The output's Git tracking state is checked before any Value is written: a Git-tracked output is refused, and an untracked one is added to the repository-local exclusion list.",
    options: {
      output: "output file (default: .env)",
      stdout:
        "write Values to stdout instead of a file; terminal stdout additionally requires --reveal",
      environment:
        "Environment id or label to pull from (default: the worktree selection)",
      force:
        "approve replacing a differing output file under --no-input; the prior file is retained at <path>.previous",
      noInput:
        "never prompt or guess; requires explicit --profile and Environment context",
    },
    notes: [
      "pull --stdout and --output are mutually exclusive, and Values never appear in JSON output: dotrelay pull --output <file> --json reports a safe summary instead.",
    ],
    examples: [
      "dotrelay pull",
      "dotrelay pull --output .env",
      "dotrelay pull --stdout --reveal",
    ],
  },
  diff: {
    about:
      "Compare .env (or --from <dotenv>) with the Environment and report added, updated, and removed Variables as names, ownership, and change types, with no Values.",
    options: {
      from: "dotenv file to compare (default: .env)",
      environment:
        "Environment id or label to compare against (default: the worktree selection)",
      reveal:
        "print the unified Value diff for this one run instead of the masked summary",
    },
    examples: ["dotrelay diff", "dotrelay diff --from .env.local"],
  },
  status: {
    about:
      "Show this machine's connection: the Server Profile, session, Device, and next repair action. Stored state is labelled as stored; only service-verified lines claim a session or Device as current.",
    examples: ["dotrelay status"],
  },
  context: {
    about:
      "Detect the GitHub Repository for this worktree from its Git remotes and resolve GitHub's stable numeric Repository id. An explicit --remote choice is recorded in the worktree context only after the command succeeds.",
    options: {
      environment:
        "Environment selection to report (default: the worktree selection)",
      noInput:
        "never prompt; an ambiguous worktree fails naming the exact --remote choices",
    },
    examples: ["dotrelay context"],
  },
  history: {
    about:
      "List the verified Revisions of the Environment with readable dates, per-Revision change context, and a #ordinal per Revision. history --json keeps the documented revision metadata for automation.",
    examples: ["dotrelay history", "dotrelay history --limit 25"],
  },
  rollback: {
    about:
      "Append a lane-scoped Rollback Revision: the selected Variables take the values recorded in the target Revision. A rollback never rewrites or removes earlier history; all other current Values are preserved.",
    positional: [
      "<revision-id-or-ordinal>  The #ordinal rendered by dotrelay history, or the stable Revision id. Omit it to choose the Revision from the rendered history; required with --no-input.",
    ],
    options: {
      variable:
        "Variable to roll back, by operator-visible name or stable Variable id; repeat for more than one. Required with --no-input.",
      environment:
        "Environment id or label to roll back in (default: the worktree selection)",
      reveal:
        "show the unified Value diff in the final review instead of the masked summary",
    },
    notes: [
      "Under --no-input the command requires explicit --profile, an explicit or saved Environment, the target Revision positional, and at least one --variable.",
    ],
    examples: [
      "dotrelay history",
      "dotrelay rollback 3 --variable DATABASE_URL",
      "dotrelay rollback <revision-id> --variable <variable-id>",
    ],
  },
  help: {
    about:
      "Show the command directory, or the usage, arguments, options, and examples for one command. The same view is rendered by dotrelay <command> --help.",
    positional: [
      "<command>  A command such as rollback, or a nested command such as device recover.",
    ],
    examples: [
      "dotrelay help",
      "dotrelay help rollback",
      "dotrelay help device recover",
    ],
  },
  "profile add": {
    about:
      "Trust and save a Server Profile. Its capabilities document is fetched from the origin and verified before the profile is trusted.",
    positional: [
      "<name>  Local name for the profile.",
      "<origin>  The Server Profile origin; a missing scheme defaults to https.",
    ],
    options: {
      noInput: "never prompt; requires --accept-profile <server-profile-id>",
    },
    examples: ["dotrelay profile add work https://relay.example"],
  },
  "profile use": {
    about:
      "Select the global Server Profile used by commands that do not pass --profile.",
    positional: ["<name>  The saved profile name."],
    examples: ["dotrelay profile use work"],
  },
  "profile list": {
    about: "List the saved Server Profiles and mark the selected one.",
    examples: ["dotrelay profile list"],
  },
  "device enroll": {
    about:
      "Bootstrap Device enrollment, or begin the dual-control flow when adding a Device to an installation that is already enrolled.",
    options: {
      output: "signed request artifact file for the dual-control handoff",
      profile: "Server Profile to enroll on (required with --no-input)",
      noInput: "never prompt; requires explicit --profile",
    },
    examples: ["dotrelay device enroll"],
  },
  "device begin": {
    about:
      "Begin dual-control enrollment and write the signed request artifact, which holds public protocol objects only.",
    options: {
      output: "request artifact file to write",
      profile: "Server Profile to enroll on (required with --no-input)",
      noInput: "never prompt; requires explicit --profile",
    },
    examples: ["dotrelay device begin --output enrollment-request.json"],
  },
  "device approve": {
    about:
      "Approve an enrollment handoff on a second authorized installation using the signed request artifact.",
    options: {
      from: "signed request artifact to approve (required)",
      profile: "Server Profile to enroll on (required with --no-input)",
      noInput: "never prompt; requires explicit --profile",
    },
    examples: ["dotrelay device approve --from enrollment-request.json"],
  },
  "device complete": {
    about:
      "Complete an approved enrollment on the installation that began it, after the approved request artifact is returned.",
    options: {
      from: "approved request artifact to complete with (required)",
      profile: "Server Profile to enroll on (required with --no-input)",
      noInput: "never prompt; requires explicit --profile",
    },
    examples: ["dotrelay device complete --from enrollment-request.json"],
  },
  "device backup": {
    about:
      "Create a Recovery Kit. The protected file is never printed in normal or JSON output; when replacing an existing path, the prior artifact is retained at <path>.previous.",
    options: {
      output: "Recovery Kit file to write (required)",
      force: "approve rotating an existing Recovery Kit",
      profile: "Server Profile to back up (required with --no-input)",
      noInput: "never prompt; requires explicit --profile",
    },
    examples: ["dotrelay device backup --output recovery-kit.json"],
  },
  "device recover": {
    about:
      "Restore this Device from a Recovery Kit. Recovery verifies the profile, User, envelope signature, and fresh challenge proof, and never falls back to initial bootstrap.",
    options: {
      from: "Recovery Kit file to restore from (required)",
      profile: "Server Profile to recover onto (required with --no-input)",
      noInput: "never prompt; requires explicit --profile",
    },
    examples: ["dotrelay device recover --from recovery-kit.json"],
  },
  "project link": {
    about:
      "Link a Project explicitly: the resolved GitHub Repository id is sent to the authenticated Server Profile, which creates a default Environment when the Project is new.",
    options: {
      team: "Team id the Project is linked into (required)",
    },
    notes: [
      "Requires an authenticated session and an active enrolled Device; a session from dotrelay login alone is insufficient until this machine has a Device.",
    ],
    examples: ["dotrelay project link --team <team-id>"],
  },
  "env use": {
    about:
      "Select the worktree Environment by id or operator-visible label, resolved within the worktree's Project. The selection is saved in the worktree context.",
    positional: [
      "<environment-id-or-label>  The Environment id or label to select; alternatively pass --environment.",
    ],
    options: {
      environment: "Environment id or label (alternative to the positional)",
    },
    notes: [
      "A Project must be linked first: run dotrelay project link or dotrelay init.",
    ],
    examples: [
      "dotrelay env use development",
      "dotrelay env use --environment <environment-id>",
    ],
  },
};

const GROUP_ABOUT: Readonly<Partial<Record<CommandName, string>>> = {
  profile:
    "Save, select, and list the Server Profiles this installation trusts.",
  device:
    "Manage Device enrollment, dual-control handoffs, and Recovery Kits for this machine.",
  project: "Manage the Project linked to this GitHub Repository.",
  env: "Select the worktree Environment.",
};

const SHARED_FLAG_SUMMARIES: Readonly<Partial<Record<FlagKey, string>>> = {
  profile: "Server Profile to use (default: the globally selected profile)",
  acceptProfile:
    "exact Server Profile id to trust without prompting; required with --no-input",
  environment: "Environment id or label (default: the worktree selection)",
  output: "output file",
  from: "input file",
  team: "Team id used to resolve the Project",
  name: "not supported by any command",
  remote: "Git remote that identifies this worktree when remotes are ambiguous",
  limit: "number of Revisions to fetch from the service (1-256; default: all)",
  classify:
    "classify a new Variable as shared or user-defined (NAME=shared|user-defined)",
  variable:
    "Variable to roll back, by operator-visible name or stable Variable id; repeat for more",
  noOpen: "do not open the verification page in a browser",
  noInput: "never prompt, guess, or approve",
  force: "approve the documented destructive effect of this command",
  json: "machine-readable JSON output; Values never appear in JSON",
  reveal:
    "show plaintext Values in the one human review (never in JSON or diagnostics)",
  stdout: "write Values to stdout; requires --reveal when stdout is a terminal",
};

const FLAG_SIGNATURES: Readonly<Partial<Record<FlagKey, string>>> = {
  profile: " <name>",
  acceptProfile: " <server-profile-id>",
  environment: " <environment-id-or-label>",
  output: " <file>",
  from: " <file>",
  team: " <team-id>",
  remote: " <remote-name>",
  limit: " <count>",
  classify: " NAME=shared|user-defined",
  variable: " <variable-name-or-id>",
};

// Mirrors the parser's token walk well enough to route --help: the first
// non-flag token is the command, and a grouped command (profile, device,
// project, env) takes one more non-flag token as its subcommand.
export const helpTopicFor = (args: readonly string[]): string[] => {
  const topic: string[] = [];
  for (const token of args) {
    if (token === "--") break;
    if (token.startsWith("--")) continue;
    topic.push(token);
    if (topic.length === 2) break;
    const first = topic[0];
    if (!first || !SUBCOMMANDS[first as CommandName]) break;
  }
  return topic;
};

export const helpLabelFor = (topic: readonly string[]): string | null => {
  if (topic.length === 0) return null;
  const command = topic[0];
  if (!command || !COMMANDS.includes(command as CommandName)) return null;
  const subcommands = SUBCOMMANDS[command as CommandName];
  if (subcommands) {
    if (topic.length === 1) return command;
    const sub = topic[1];
    if (topic.length !== 2 || !sub) return null;
    return subcommands.includes(sub) ? `${command} ${sub}` : null;
  }
  return topic.length === 1 ? command : null;
};

const wrapLines = (text: string, width: number, indent: string): string[] => {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(`${indent}${current}`);
      current = word;
    }
  }
  if (current.length > 0) lines.push(`${indent}${current}`);
  return lines;
};

const wrapped = (text: string, width: number, indent: string): string =>
  wrapLines(text, width, indent).join("\n");

const renderLeafHelp = (label: string): string => {
  const entry = COMMAND_HELP[label];
  if (!entry)
    throw new CliInvocationError(
      `no help is available for ${label}; usage: dotrelay help [<command>]`,
    );
  const lines = [
    `${bold("Usage:")} ${usageForLabel(label)}`,
    "",
    ...wrapLines(entry.about, 64, "  ").map((line) => paint(line, "muted")),
  ];
  if (entry.positional?.length) {
    lines.push("", paint("Arguments:", "info"));
    for (const line of entry.positional)
      lines.push(wrapped(`  ${line}`, 72, "  "));
  }
  lines.push("", paint("Options:", "info"));
  const allowed = FLAG_PERMISSIONS[label] ?? [];
  const signatures = FLAG_KEYS.filter((key) => allowed.includes(key)).map(
    (key) => {
      const summary = entry.options?.[key] ?? SHARED_FLAG_SUMMARIES[key] ?? "";
      return `  ${FLAG_TOKENS[key]}${FLAG_SIGNATURES[key] ?? ""}  ${summary}`;
    },
  );
  signatures.push("  --debug  include sanitized detail in error diagnostics");
  const parsed = signatures.map((line) => {
    const body = line.slice(2);
    const index = body.indexOf("  ");
    return {
      flag: index === -1 ? body : body.slice(0, index),
      summary: index === -1 ? "" : body.slice(index + 2),
    };
  });
  const flagWidth = Math.max(...parsed.map((row) => row.flag.length), 4);
  for (const { flag, summary } of parsed) {
    lines.push(
      `  ${bold(flag.padEnd(flagWidth))}${
        summary.length > 0 ? `  ${paint(summary, "muted")}` : ""
      }`,
    );
  }
  if (entry.notes?.length) {
    lines.push("", paint("Notes:", "info"));
    for (const note of entry.notes) lines.push(wrapped(`  ${note}`, 72, "  "));
  }
  lines.push("", paint("Examples:", "info"));
  for (const example of entry.examples)
    lines.push(`  ${paint(">", "ghost")} ${example}`);
  return lines.join("\n");
};

const renderGroupHelp = (command: CommandName): string => {
  const subcommands = SUBCOMMANDS[command] ?? [];
  const lines = [`${bold("Usage:")} dotrelay ${command} <subcommand>`, ""];
  const about = GROUP_ABOUT[command];
  if (about)
    lines.push(
      ...wrapLines(about, 64, "  ").map((line) => paint(line, "muted")),
      "",
    );
  lines.push(paint("Subcommands:", "info"));
  const subs = subcommands.map((sub) => ({
    sub,
    about: COMMAND_HELP[`${command} ${sub}`]?.about ?? "",
  }));
  const nameWidth = Math.max(...subs.map((row) => row.sub.length), 4);
  for (const { sub, about } of subs)
    lines.push(
      `  ${bold(sub.padEnd(nameWidth))}${
        about.length > 0 ? `  ${paint(about, "muted")}` : ""
      }`,
    );
  lines.push(
    "",
    paint(
      `Run dotrelay help ${command} <subcommand> for the full help of one subcommand.`,
      "faint",
    ),
  );
  return lines.join("\n");
};

export const renderCommandHelp = (label: string): string => {
  const [command, sub] = label.split(" ");
  if (command && SUBCOMMANDS[command as CommandName] && !sub)
    return renderGroupHelp(command as CommandName);
  return renderLeafHelp(label);
};

// The command directory. Usage prefixes are taken verbatim from the parser's
// usage table (the primary form, before any " | " alternative) so the
// directory can never drift from what the parser accepts.
const EVERYDAY_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ["setup", "Trust a Server Profile, sign in, and enroll this machine"],
  ["login", "Sign in and enroll this machine"],
  ["init", "Publish this repository's .env for the first time"],
  ["push", "Publish changes from .env"],
  ["pull", "Write decrypted values to .env"],
  ["diff", "Compare .env with the Environment"],
  ["status", "Show this machine's connection"],
];

const POWER_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ["help", "Show this list, or the help for one command"],
  ["profile add", "Trust and save a Server Profile"],
  ["profile use", "Select the global Server Profile"],
  ["profile list", "List saved Server Profiles"],
  ["logout", "Remove the local session"],
  ["device enroll", "Bootstrap or begin Device enrollment"],
  ["device begin", "Begin dual-control enrollment"],
  ["device approve", "Approve an enrollment handoff"],
  ["device complete", "Complete an approved enrollment"],
  ["device backup", "Create a Recovery Kit"],
  ["device recover", "Restore a Device from a Recovery Kit"],
  ["context", "Detect the GitHub Repository"],
  ["project link", "Link a Project explicitly"],
  ["env use", "Select an Environment by id or label"],
  ["history", "List verified Revisions with readable context"],
  ["rollback", "Append a lane-scoped Rollback Revision"],
];

const commandDirectory = (
  items: ReadonlyArray<readonly [string, string]>,
): string[] => {
  const usages = items.map(([label]) => {
    const usage = usageForLabel(label)
      .replace(/^dotrelay /, "")
      .split(" | ")[0];
    return usage ?? "";
  });
  const width = Math.max(...usages.map((usage) => usage.length), 4);
  return items.map(
    ([, summary], index) =>
      `  ${bold((usages[index] ?? "").padEnd(width))}  ${paint(summary, "muted")}`,
  );
};

export const renderHelp = (): string => {
  const lines = [
    banner(),
    "",
    `${bold("Usage:")} dotrelay <command>`,
    "",
    section("Everyday"),
    ...commandDirectory(EVERYDAY_COMMANDS),
    "",
    section("More"),
    `  ${bold("dotrelay help".padEnd(14))}  ${paint("Every command, with flags and examples", "muted")}`,
    `  ${bold("dotrelay help <command>")}  ${paint("Full help for one command", "muted")}`,
    "",
    section("Flags"),
    `  ${bold("--profile <name>".padEnd(14))}  ${paint("Choose the Server Profile", "muted")}`,
    `  ${bold("--environment".padEnd(14))}  ${paint("Choose the Environment by id or label", "muted")}`,
    `  ${bold("--json".padEnd(14))}  ${paint("Machine-readable output; values never appear", "muted")}`,
    `  ${bold("--no-input".padEnd(14))}  ${paint("Never prompt, guess, or approve", "muted")}`,
    `  ${bold("--debug".padEnd(14))}  ${paint("Include sanitized detail in error diagnostics", "muted")}`,
  ];
  if (defaultOrigin)
    lines.push(
      "",
      paint(
        `Default: with no Server Profile selected, this build uses ${defaultOrigin}`,
        "faint",
      ),
    );
  return lines.join("\n");
};

export const renderPowerHelp = (): string => {
  return [
    banner(),
    "",
    `${bold("Usage:")} dotrelay <command> [subcommand]`,
    "",
    section("Everyday"),
    ...commandDirectory(EVERYDAY_COMMANDS),
    "",
    section("Power"),
    ...commandDirectory(POWER_COMMANDS),
    "",
    paint(
      "Run dotrelay help <command> or dotrelay <command> --help for the full help, arguments, and examples of one command.",
      "faint",
    ),
    "",
    section("Shared flags"),
    `  ${bold("--profile <name>".padEnd(18))}  ${paint("Server Profile to use", "muted")}`,
    `  ${bold("--environment".padEnd(18))}  ${paint("Environment id or label", "muted")}`,
    `  ${bold("--team <id>".padEnd(18))}  ${paint("Team that scopes the Project lookup", "muted")}`,
    `  ${bold("--json  --no-input".padEnd(18))}  ${paint("Automation mode; no prompts, no guesses", "muted")}`,
    `  ${bold("--force".padEnd(18))}  ${paint("Approve the documented destructive effect", "muted")}`,
    "",
    section("Notes"),
    "  Pull writes decrypted values; untracked outputs get a repository-local",
    "  Git exclusion, and Git-tracked outputs are refused. Change previews",
    "  show names and change types only; --reveal shows plaintext values",
    "  for one human review, never in JSON or diagnostics.",
    "",
    "  Rollback appends a signed Rollback Revision for the selected Variables;",
    "  earlier Revisions are never rewritten or removed.",
    "",
    "  Values are never diagnostic data. --insecure and credential flags are",
    "  not supported.",
  ].join("\n");
};
