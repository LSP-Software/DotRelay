import { describe, expect, test } from "bun:test";
import {
  COMMANDS,
  type CommandName,
  FLAG_PERMISSIONS,
  FLAG_TOKENS,
  type FlagKey,
  parseArguments,
  SUBCOMMANDS,
  displayUsage,
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
      if (subcommands) {
        if (sub === undefined)
          expect(() => parseArguments([command ?? ""]), label).not.toThrow();
        else expect(subcommands, label).toContain(sub);
      } else expect(sub, label).toBeUndefined();
    }
  });

  test("help usage lines match the parser usage table", () => {
    for (const [label] of Object.entries(COMMAND_HELP)) {
      const rendered = renderCommandHelp(label);
      expect(
        rendered.startsWith(`Usage: ${displayUsage(usageForLabel(label))}`),
        label,
      ).toBe(true);
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
      "Usage: dotrelay device recover [--transfer <transfer-code> | --recovery-code-file <path>]",
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
      "Usage: dotrelay device recover [--transfer <transfer-code> | --recovery-code-file <path>]",
    );
    const group = await run(["help", "profile"]);
    expect(group.stdout).toContain("Subcommands:");
    const badSubcommand = await run(["help", "device", "frobnicate"]);
    expect(badSubcommand.exitCode).toBe(2);
    expect(badSubcommand.stderr).toMatch(/usage: dotrelay help/i);
    const unknown = await run(["help", "frobnicate"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toMatch(/usage: dotrelay help/i);
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

  // The wording of each error belongs to the parser; this contract only
  // pins the usage line it ends with and the facts it must name.
  test("validation errors carry the usage line for the invoked command", () => {
    const failure = (
      args: readonly string[],
      options?: Parameters<typeof parseArguments>[1],
    ): string => {
      try {
        parseArguments([...args], options);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error(`${args.join(" ")} was accepted`);
    };
    expect(failure(["device"])).toMatch(/usage: dotrelay device/i);
    expect(failure(["status", "extra"])).toMatch(/usage: dotrelay status/i);
    const unknownOption = failure(["status", "--frobnicate"]);
    expect(unknownOption).toContain("--frobnicate");
    expect(unknownOption).toMatch(/usage: dotrelay status/i);
    expect(failure(["history", "--limit", "0"])).toMatch(
      /usage: dotrelay history/i,
    );
    expect(failure(["pull", "--stdout", "--output", ".env"])).toMatch(
      /usage: dotrelay pull/i,
    );
    expect(failure(["pull", "--stdout"], { stdoutIsTerminal: true })).toMatch(
      /usage: dotrelay pull/i,
    );
    const link = failure(["project", "link"]);
    expect(link).toContain("--team <team-id>");
    expect(link).toMatch(/usage: dotrelay project link --team <team-id>/i);
    // An unknown subcommand has no usage line of its own: the error names
    // the group's real subcommands instead of inventing one.
    const bogus = failure(["env", "bogus"]);
    expect(bogus).toContain("list, use, create");
    expect(bogus).toMatch(/usage: dotrelay env <subcommand>/i);
    expect(bogus).not.toContain("dotrelay env bogus");
  });

  test("short aliases route to help and version", async () => {
    const help = await run(["-h"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("Usage: dotrelay <command>");
    const pullHelp = await run(["pull", "-h"]);
    expect(pullHelp.stdout).toContain("Usage: dotrelay pull");
    const version = await run(["-v"]);
    expect(version.exitCode).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("everything after -- belongs to the command dotrelay run starts", async () => {
    // --help after -- is the child's flag, so the usage error for a run
    // without a linked profile appears instead of DotRelay's help.
    const result = await run(["run", "--", "node", "--help"], {
      profilePath: `${import.meta.dir}/.tmp-missing-profile-${crypto.randomUUID()}`,
    });
    expect(result.stdout).not.toContain("Usage: dotrelay");
    expect(result.exitCode).not.toBe(0);
  });

  test("the top-level flag block is aligned and names the environment value", () => {
    const lines = renderHelp()
      .split("\n")
      .filter((line) => /^ {2}(--|-h)/.test(line));
    expect(lines.some((line) => line.includes("--environment <label>"))).toBe(
      true,
    );
    // Every summary starts in the same column, whatever the flag's length.
    const starts = lines.map((line) => {
      const match = /^ {2}(.+?) {2,}(\S.*)$/.exec(line);
      return match ? line.length - (match[2] ?? "").length : -1;
    });
    expect(starts).not.toContain(-1);
    expect(new Set(starts).size).toBe(1);
  });

  test("setup needs no address unless you self-host", () => {
    expect(renderHelp()).toContain("setup [<origin>]");
    expect(renderHelp()).toContain(
      "Run dotrelay setup to connect to api.dotrelay.dev",
    );
    expect(renderCommandHelp("setup")).toContain(
      "Defaults to https://api.dotrelay.dev",
    );
    expect(renderCommandHelp("setup")).toContain("> dotrelay setup\n");
  });
});
