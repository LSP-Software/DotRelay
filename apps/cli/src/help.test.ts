import { describe, expect, test } from "bun:test";
import {
  COMMANDS,
  type CommandName,
  FLAG_PERMISSIONS,
  FLAG_TOKENS,
  type FlagKey,
  parseArguments,
  SUBCOMMANDS,
  usageForLabel,
} from "./args";
import {
  COMMAND_HELP,
  helpLabelFor,
  helpTopicFor,
  renderCommandHelp,
} from "./help";
import { renderHelp, renderPowerHelp, run } from "./index";

const usagePrefix = (label: string): string =>
  usageForLabel(label).replace(/^dotrelay /, "");

// The Options section runs from its header until the first line that is not
// an indented flag line, so prose in Notes can never be read as an option.
const renderedOptions = (rendered: string): string[] => {
  const lines = rendered.split("\n");
  const start = lines.indexOf("Options:");
  if (start < 0) return [];
  const options: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("  --")) break;
    options.push(line.trim().split(" ")[0] ?? "");
  }
  return options;
};

const allowedOptionTokens = (label: string): string[] => [
  ...(FLAG_PERMISSIONS[label] ?? []).map((key) => FLAG_TOKENS[key as FlagKey]),
  "--debug",
];

describe("command help contract", () => {
  test("every parser command and nested command has a matching help entry", () => {
    for (const command of COMMANDS) {
      const subcommands = SUBCOMMANDS[command];
      if (subcommands) {
        expect(subcommands.length, command).toBeGreaterThan(0);
        for (const sub of subcommands)
          expect(
            COMMAND_HELP[`${command} ${sub}`],
            `${command} ${sub}`,
          ).toBeDefined();
      } else {
        expect(COMMAND_HELP[command], command).toBeDefined();
      }
    }
    for (const label of Object.keys(COMMAND_HELP)) {
      const [command, sub] = label.split(" ");
      expect(COMMANDS, label).toContain(command as (typeof COMMANDS)[number]);
      const subcommands = command
        ? SUBCOMMANDS[command as CommandName]
        : undefined;
      if (subcommands) expect(subcommands, label).toContain(sub ?? "");
      else expect(sub, label).toBeUndefined();
    }
  });

  test("help usage lines match the parser usage table", () => {
    for (const [label] of Object.entries(COMMAND_HELP)) {
      const rendered = renderCommandHelp(label);
      expect(rendered.startsWith(`Usage: ${usageForLabel(label)}`), label).toBe(
        true,
      );
    }
  });

  // The primary form of each rendered usage line (before any " | "
  // alternative) must be an invocation the parser accepts, so a help line
  // can never advertise syntax the parser would reject.
  test("the usage line of every help entry is an invocation the parser accepts", () => {
    for (const [label] of Object.entries(COMMAND_HELP)) {
      const primary = (usagePrefix(label).split(" | ")[0] ?? "").split(" ");
      expect(() => parseArguments(primary), label).not.toThrow();
    }
  });

  // The parser-enforced required flags must stay labelled as required in the
  // option list of the command that needs them.
  test("help marks parser-required options as required", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["device approve", "--from"],
      ["device complete", "--from"],
      ["device recover", "--from"],
      ["device backup", "--output"],
      ["project link", "--team"],
    ];
    for (const [label, flag] of cases) {
      const rendered = renderCommandHelp(label);
      const line = rendered
        .split("\n")
        .find((candidate) => candidate.trimStart().startsWith(flag));
      expect(line, `${label} ${flag}`).toBeDefined();
      expect(line, `${label} ${flag}`).toContain("required");
    }
  });

  test("help examples use only commands and flags the parser accepts", () => {
    for (const [label, entry] of Object.entries(COMMAND_HELP)) {
      expect(entry.examples.length, label).toBeGreaterThan(0);
      for (const example of entry.examples) {
        const tokens = example.trim().split(/\s+/);
        expect(tokens[0], example).toBe("dotrelay");
        expect(() => parseArguments(tokens.slice(1)), example).not.toThrow();
      }
    }
  });

  test("help option lists match the parser flag permissions", () => {
    for (const label of Object.keys(COMMAND_HELP)) {
      const options = renderedOptions(renderCommandHelp(label)).sort();
      const allowed = [...allowedOptionTokens(label)].sort();
      expect(options, label).toEqual(allowed);
    }
  });

  test("the command directory lists every parser command with its usage", () => {
    const directory = `${renderHelp()}\n${renderPowerHelp()}`;
    for (const label of Object.keys(COMMAND_HELP))
      expect(directory, label).toContain(
        usagePrefix(label).split(" | ")[0] ?? "",
      );
  });

  test("--help routes to the selected command's help", async () => {
    const everyday = renderHelp();
    const rollback = await run(["rollback", "--help"]);
    expect(rollback.exitCode).toBe(0);
    expect(rollback.stdout).toContain(
      "Usage: dotrelay rollback <revision-id-or-ordinal> --variable <variable-name-or-id>…",
    );
    expect(rollback.stdout).toContain("Examples:");
    expect(rollback.stdout).not.toBe(`${everyday}\n`);
    const recover = await run(["device", "recover", "--help"]);
    expect(recover.stdout).toContain(
      "Usage: dotrelay device recover --from <file>",
    );
    const begin = await run(["device", "begin", "--help"]);
    expect(begin.stdout).toContain(
      "Usage: dotrelay device begin --output <file>",
    );
    const group = await run(["device", "--help"]);
    expect(group.stdout).toContain("Subcommands:");
    for (const sub of SUBCOMMANDS.device ?? [])
      expect(group.stdout).toContain(sub);
    const unknown = await run(["frobnicate", "--help"]);
    expect(unknown.exitCode).toBe(0);
    expect(unknown.stdout).toBe(`${everyday}\n`);
  });

  test("the help command renders per-command and nested command views", async () => {
    const list = await run(["help"]);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("device begin");
    expect(list.stdout).toContain("rollback <revision-id-or-ordinal>");
    expect(list.stdout).toContain("--variable");
    const one = await run(["help", "rollback"]);
    expect(one.exitCode).toBe(0);
    expect(one.stdout).toContain("Usage: dotrelay rollback");
    expect(one.stdout).toContain("--variable");
    const nested = await run(["help", "device", "recover"]);
    expect(nested.stdout).toContain(
      "Usage: dotrelay device recover --from <file>",
    );
    const group = await run(["help", "profile"]);
    expect(group.stdout).toContain("Subcommands:");
    const badSubcommand = await run(["help", "device", "frobnicate"]);
    expect(badSubcommand.exitCode).toBe(2);
    expect(badSubcommand.stderr).toContain("usage: dotrelay help");
    const unknown = await run(["help", "frobnicate"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain("usage: dotrelay help");
  });

  test("--help topic extraction follows the parser's command shape", () => {
    expect(helpLabelFor(helpTopicFor(["rollback", "--help"]))).toBe("rollback");
    expect(helpLabelFor(helpTopicFor(["device", "recover", "--help"]))).toBe(
      "device recover",
    );
    expect(helpLabelFor(helpTopicFor(["device", "--help"]))).toBe("device");
    expect(helpLabelFor(helpTopicFor(["profile", "use", "--help"]))).toBe(
      "profile use",
    );
    expect(helpLabelFor(helpTopicFor(["--help"]))).toBeNull();
    expect(helpLabelFor(helpTopicFor([]))).toBeNull();
    expect(helpLabelFor(helpTopicFor(["frobnicate", "--help"]))).toBeNull();
    expect(
      helpLabelFor(helpTopicFor(["device", "frobnicate", "--help"])),
    ).toBeNull();
    // A known command with extra junk still routes to its own help.
    expect(helpLabelFor(helpTopicFor(["status", "extra", "--help"]))).toBe(
      "status",
    );
  });

  test("validation errors carry the usage line for the invoked command", () => {
    expect(() => parseArguments(["device"])).toThrow("usage: dotrelay device");
    expect(() => parseArguments(["status", "extra"])).toThrow(
      "usage: dotrelay status",
    );
    expect(() => parseArguments(["status", "--frobnicate"])).toThrow(
      "unknown option: --frobnicate; usage: dotrelay status",
    );
    expect(() => parseArguments(["history", "--limit", "0"])).toThrow(
      "usage: dotrelay history",
    );
    expect(() =>
      parseArguments(["pull", "--stdout", "--output", ".env"]),
    ).toThrow("usage: dotrelay pull");
    expect(() =>
      parseArguments(["pull", "--stdout"], { stdoutIsTerminal: true }),
    ).toThrow("usage: dotrelay pull");
    expect(() => parseArguments(["project", "link"])).toThrow(
      "project link requires --team <team-id>; usage: dotrelay project link --team <team-id>",
    );
  });
});
