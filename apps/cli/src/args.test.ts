import { describe, expect, test } from "bun:test";
import {
  CliInvocationError,
  ownArguments,
  parseArguments,
  rejectForbiddenFlags,
} from "./args";

describe("CLI argument contract", () => {
  test("parses profile override and safe output flags", () => {
    expect(
      parseArguments([
        "pull",
        "--profile",
        "work",
        "--environment",
        "production",
        "--output",
        ".env",
        "--no-input",
      ]),
    ).toMatchObject({
      command: "pull",
      profile: "work",
      environment: "production",
      output: ".env",
      noInput: true,
    });
  });

  test("setup and profile add need no server identity flag", () => {
    expect(
      parseArguments(["setup", "https://relay.example", "--no-input"]).noInput,
    ).toBe(true);
    expect(() =>
      parseArguments([
        "setup",
        "https://relay.example",
        "--accept-profile",
        "id",
      ]),
    ).toThrow();
  });

  test("rejects insecure and credential-bearing flags", () => {
    expect(() => parseArguments(["status", "--insecure"])).toThrow(
      CliInvocationError,
    );
    expect(() => parseArguments(["login", "--token", "secret"])).toThrow(
      CliInvocationError,
    );
  });

  test("rejects stdout on a terminal unless reveal is explicit", () => {
    expect(() =>
      parseArguments(["pull", "--stdout"], { stdoutIsTerminal: true }),
    ).toThrow("--reveal");
    expect(
      parseArguments(["pull", "--stdout", "--reveal"], {
        stdoutIsTerminal: true,
      }).reveal,
    ).toBe(true);
  });

  test("requires explicit lane ownership and supports lane-scoped Rollback", () => {
    expect(
      parseArguments(["push", "--from", ".env", "--classify", "API_URL=shared"])
        .classifications,
    ).toEqual({ API_URL: "shared" });
    expect(
      parseArguments([
        "rollback",
        "11111111-1111-4111-8111-111111111111",
        "--variable",
        "22222222-2222-4222-8222-222222222222",
      ]).variableReferences,
    ).toEqual(["22222222-2222-4222-8222-222222222222"]);
    // Variables are selected by operator-visible name as well as by the
    // stable id; the live Manifest resolves a name before the Rollback is
    // built, so parse time cannot reject a name it has not seen yet.
    expect(
      parseArguments([
        "rollback",
        "11111111-1111-4111-8111-111111111111",
        "--variable",
        "DATABASE_URL",
      ]).variableReferences,
    ).toEqual(["DATABASE_URL"]);
    // Interactively the target Revision and the Variables can both be
    // chosen from the rendered history instead of named on the command
    // line.
    expect(
      parseArguments(["rollback", "11111111-1111-4111-8111-111111111111"]),
    ).toMatchObject({
      command: "rollback",
    });
    expect(parseArguments(["rollback"])).toMatchObject({
      command: "rollback",
      positionals: [],
    });
    expect(() =>
      parseArguments([
        "rollback",
        "--no-input",
        "11111111-1111-4111-8111-111111111111",
      ]),
    ).toThrow("--variable");
    expect(() => parseArguments(["rollback", "--no-input"])).toThrow(
      "dotrelay rollback needs the revision to roll back to.",
    );
  });

  test("accepts the Device trust handoff commands", () => {
    expect(
      parseArguments(["device", "begin", "--output", "request.json"]),
    ).toMatchObject({
      command: "device",
      subcommand: "begin",
      output: "request.json",
    });
    expect(
      parseArguments(["device", "approve", "--from", "request.json"]),
    ).toMatchObject({
      command: "device",
      subcommand: "approve",
      from: "request.json",
    });
    expect(
      parseArguments(["device", "complete", "--from", "request.json"]),
    ).toMatchObject({ command: "device", subcommand: "complete" });
    expect(parseArguments(["device", "backup"])).toMatchObject({
      command: "device",
      subcommand: "backup",
    });
    expect(
      parseArguments(["device", "recover", "--recovery-code-file", "CODE.txt"]),
    ).toMatchObject({
      command: "device",
      subcommand: "recover",
      recoveryCodeFile: "CODE.txt",
    });
    // The Recovery Code itself never appears in argv: the flag takes the
    // path of the 0600 file that holds the code.
    expect(() =>
      parseArguments(["device", "recover", "--recovery-code", "CODE"]),
    ).toThrow("DotRelay has no --recovery-code option.");
    expect(parseArguments(["device", "transfer"])).toMatchObject({
      command: "device",
      subcommand: "transfer",
    });
    expect(() => parseArguments(["device", "transfer", "--no-input"])).toThrow(
      "--to",
    );
    expect(parseArguments(["device", "revoke-wrapper"])).toMatchObject({
      command: "device",
      subcommand: "revoke-wrapper",
    });
    expect(() =>
      parseArguments(["device", "revoke-wrapper", "--no-input"]),
    ).toThrow("--wrapper-id");
    expect(
      parseArguments(["device", "recover", "--transfer", "abc123"]),
    ).toMatchObject({
      command: "device",
      subcommand: "recover",
      transfer: "abc123",
    });
  });

  test("requires explicit handoff files in the trust commands", () => {
    expect(() => parseArguments(["device", "approve"])).toThrow("--from");
    expect(() => parseArguments(["device", "complete"])).toThrow("--from");
    // No channel is required: the code may also be entered at a hidden
    // prompt or piped on stdin.
    expect(parseArguments(["device", "recover"])).toMatchObject({
      command: "device",
      subcommand: "recover",
    });
    expect(() =>
      parseArguments([
        "device",
        "recover",
        "--recovery-code-file",
        "C",
        "--transfer",
        "T",
      ]),
    ).toThrow("not both");
  });

  test("accepts --debug as a global flag", () => {
    expect(parseArguments(["status", "--debug"]).debug).toBe(true);
  });

  test("--force is a narrow approval limited to destructive workflows", () => {
    expect(
      parseArguments(["pull", "--output", ".env", "--no-input", "--force"])
        .force,
    ).toBe(true);
    expect(parseArguments(["push", "--no-input", "--force"]).force).toBe(true);
    expect(
      parseArguments([
        "device",
        "recover",
        "--recovery-code-file",
        "C.txt",
        "--no-input",
      ]).force,
    ).toBe(false);
    expect(parseArguments(["pull", "--output", ".env"]).force).toBe(false);
    expect(() => parseArguments(["diff", "--no-input", "--force"])).toThrow(
      "--force",
    );
    expect(() => parseArguments(["status", "--force"])).toThrow("--force");
    expect(() =>
      parseArguments([
        "rollback",
        "11111111-1111-4111-8111-111111111111",
        "--variable",
        "22222222-2222-4222-8222-222222222222",
        "--force",
      ]),
    ).toThrow("--force");
  });

  test("accepts diff with --from and --reveal", () => {
    expect(parseArguments(["diff", "--from", ".env.local"])).toMatchObject({
      command: "diff",
      from: ".env.local",
    });
    expect(parseArguments(["diff", "--reveal"]).reveal).toBe(true);
    expect(() => parseArguments(["status", "--reveal"])).toThrow("--reveal");
    expect(() => parseArguments(["diff", "extra"])).toThrow(
      "dotrelay diff doesn't take the argument extra. To choose an environment, use --environment extra.\nUsage: dotrelay diff",
    );
  });

  test("rejects unexpected positionals with a correction and usage", () => {
    expect(() => parseArguments(["pull", "production"])).toThrow(
      "dotrelay pull doesn't take the argument production. To choose an environment, use --environment production.\nUsage: dotrelay pull",
    );
    expect(() => parseArguments(["pull", "a", "b"])).toThrow(
      "dotrelay pull doesn't take the arguments a b.\nUsage: dotrelay pull",
    );
    expect(() => parseArguments(["push", "extra"])).toThrow(
      "Usage: dotrelay push",
    );
    expect(() => parseArguments(["login", "extra"])).toThrow(
      "Usage: dotrelay login",
    );
    expect(() => parseArguments(["logout", "extra"])).toThrow(
      "Usage: dotrelay logout",
    );
    expect(() => parseArguments(["status", "extra"])).toThrow(
      "Usage: dotrelay status",
    );
    expect(() => parseArguments(["context", "extra"])).toThrow(
      "Usage: dotrelay context",
    );
    expect(() => parseArguments(["history", "extra"])).toThrow(
      "Usage: dotrelay history",
    );
    expect(() =>
      parseArguments(["setup", "https://a.example", "https://b.example"]),
    ).toThrow("Usage: dotrelay setup [<origin>]");
    // The address is optional: only a self-hoster names one.
    expect(parseArguments(["setup"]).positionals).toEqual([]);
    expect(() =>
      parseArguments([
        "rollback",
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "--variable",
        "33333333-3333-4333-8333-333333333333",
      ]),
    ).toThrow("Usage: dotrelay rollback");
  });

  test("rejects mutually exclusive pull output combinations", () => {
    expect(() =>
      parseArguments(["pull", "--stdout", "--output", ".env"]),
    ).toThrow(
      "Use --stdout to print the values or --output <file> to write them to a file, not both.",
    );
    expect(() => parseArguments(["pull", "--stdout", "--json"])).toThrow(
      "--stdout doesn't work with --json",
    );
    expect(parseArguments(["pull", "--output", ".env", "--json"]).json).toBe(
      true,
    );
    expect(
      parseArguments(["pull", "--stdout", "--reveal", "--no-input"]).stdout,
    ).toBe(true);
  });

  test("rejects flags the command does not consume", () => {
    expect(() => parseArguments(["pull", "--name", "app"])).toThrow("--name");
    expect(() => parseArguments(["status", "--name", "app"])).toThrow("--name");
    expect(() => parseArguments(["status", "--limit", "5"])).toThrow(
      "--limit doesn\'t work with dotrelay status",
    );
    expect(() => parseArguments(["status", "--no-open"])).toThrow("--no-open");
    expect(() => parseArguments(["login", "--environment", "prod"])).toThrow(
      "--environment doesn\'t work with dotrelay login",
    );
    expect(() => parseArguments(["logout", "--no-input"])).toThrow(
      "--no-input",
    );
    expect(() =>
      parseArguments(["setup", "https://relay.example", "--profile", "relay"]),
    ).toThrow("--profile doesn\'t work with dotrelay setup");
    expect(() => parseArguments(["help", "--json"])).toThrow("--json");
    expect(() => parseArguments(["device", "backup", "--from", "kit"])).toThrow(
      "--from doesn\'t work with dotrelay device backup",
    );
    expect(parseArguments(["history", "--limit", "25"]).limit).toBe(25);
    expect(parseArguments(["pull", "--limit", "25"]).limit).toBe(25);
    expect(() => parseArguments(["status", "--limit", "999"])).toThrow(
      "--limit doesn\'t work with dotrelay status",
    );
    expect(() => parseArguments(["history", "--limit", "0"])).toThrow(
      "--limit must be a whole number from 1 to 256",
    );
    expect(() => parseArguments(["history", "--limit", "257"])).toThrow(
      "--limit must be a whole number from 1 to 256",
    );
  });

  test("rejects a missing flag value even when the next token looks like a flag", () => {
    expect(() => parseArguments(["pull", "--profile", "--reveal"])).toThrow(
      "--profile needs a value",
    );
    expect(() => parseArguments(["pull", "--environment", "--stdout"])).toThrow(
      "--environment needs a value",
    );
    expect(() => parseArguments(["pull", "--output"])).toThrow(
      "--output needs a value",
    );
    expect(() => parseArguments(["pull", "--profile", "--reveal"])).toThrow(
      "Usage: dotrelay pull",
    );
    expect(() => parseArguments(["pull", "--profile="])).toThrow(
      "--profile needs a value",
    );
    expect(parseArguments(["pull", "--profile=work"]).profile).toBe("work");
  });

  test("rejects an Environment id supplied both as an argument and with --environment", () => {
    expect(() =>
      parseArguments(["env", "use", "abc", "--environment", "abc"]),
    ).toThrow("either as an argument or with --environment");
    expect(() =>
      parseArguments(["init", "abc", "--environment", "abc"]),
    ).toThrow("either as an argument or with --environment");
  });

  test("scopes --reveal to reviews that can show plaintext Values", () => {
    expect(parseArguments(["pull", "--stdout", "--reveal"]).reveal).toBe(true);
    expect(parseArguments(["init", "--reveal"]).reveal).toBe(true);
    expect(parseArguments(["push", "--reveal"]).reveal).toBe(true);
    expect(
      parseArguments([
        "rollback",
        "11111111-1111-4111-8111-111111111111",
        "--variable",
        "22222222-2222-4222-8222-222222222222",
        "--reveal",
      ]).reveal,
    ).toBe(true);
    expect(() => parseArguments(["status", "--reveal"])).toThrow("--reveal");
    expect(() => parseArguments(["history", "--reveal"])).toThrow("--reveal");
  });

  test("accepts --remote on the commands that resolve a GitHub Repository", () => {
    expect(parseArguments(["context", "--remote", "upstream"]).remote).toBe(
      "upstream",
    );
    expect(
      parseArguments(["context", "--remote=upstream", "--no-input"]).remote,
    ).toBe("upstream");
    expect(
      parseArguments([
        "project",
        "link",
        "--team",
        "team-1",
        "--remote",
        "origin",
      ]).remote,
    ).toBe("origin");
    expect(parseArguments(["push", "--remote", "upstream"]).remote).toBe(
      "upstream",
    );
    expect(parseArguments(["pull", "--remote", "origin"]).remote).toBe(
      "origin",
    );
    expect(parseArguments(["diff", "--remote", "origin"]).remote).toBe(
      "origin",
    );
    expect(parseArguments(["history", "--remote", "origin"]).remote).toBe(
      "origin",
    );
  });

  test("rejects --remote on commands that do not resolve a repository", () => {
    expect(() => parseArguments(["login", "--remote", "origin"])).toThrow(
      "--remote",
    );
    expect(() => parseArguments(["status", "--remote", "origin"])).toThrow(
      "--remote",
    );
    expect(() =>
      parseArguments(["env", "use", "abc", "--remote", "origin"]),
    ).toThrow("--remote");
    expect(() =>
      parseArguments(["device", "enroll", "--remote", "origin"]),
    ).toThrow("--remote");
  });

  test("accepts setup, help, and --team on push", () => {
    expect(parseArguments(["setup", "https://relay.example"])).toMatchObject({
      command: "setup",
      positionals: ["https://relay.example"],
    });
    expect(parseArguments(["help"]).command).toBe("help");
    expect(
      parseArguments(["push", "--from", ".env", "--team", "team-1"]).team,
    ).toBe("team-1");
  });

  test("accepts -o as the short form of --output", () => {
    expect(parseArguments(["pull", "-o", ".env.local"]).output).toBe(
      ".env.local",
    );
    expect(() => parseArguments(["pull", "-o"])).toThrow("-o needs a value");
    expect(() => parseArguments(["status", "-o", "x"])).toThrow(
      "--output doesn\'t work with dotrelay status",
    );
  });

  test("names an unknown short option instead of treating it as a command", () => {
    expect(() => parseArguments(["pull", "-x"])).toThrow(
      "DotRelay has no -x option. Options start with two dashes",
    );
    expect(() => parseArguments(["-x"])).toThrow("DotRelay has no -x option.");
  });

  test("never starts an error with the operator's own input", () => {
    expect(() => parseArguments(["bogus"])).toThrow(
      "DotRelay has no bogus command. Run dotrelay help",
    );
    expect(() => parseArguments(["pull", "extra"])).toThrow(
      /^dotrelay pull doesn't take/,
    );
    expect(() => parseArguments(["env"])).toThrow(
      "dotrelay env needs a subcommand: list, use, create.",
    );
  });

  test("parses env list, env create, team list, team share-keys, and device list", () => {
    expect(parseArguments(["env", "list"]).subcommand).toBe("list");
    expect(parseArguments(["env", "create", "staging"]).positionals).toEqual([
      "staging",
    ]);
    expect(() => parseArguments(["env", "create"])).toThrow(
      "Usage: dotrelay env create <label>",
    );
    expect(() => parseArguments(["env", "list", "extra"])).toThrow(
      "Usage: dotrelay env list",
    );
    expect(parseArguments(["team", "list", "--json"]).json).toBe(true);
    expect(
      parseArguments(["team", "share-keys", "octocat", "--team", "t"])
        .positionals,
    ).toEqual(["octocat"]);
    expect(() => parseArguments(["team", "share-keys"])).toThrow(
      "Usage: dotrelay team share-keys <github-login-or-user-id>",
    );
    // --fingerprint takes the 40 hex digits as shown, spaces allowed, and is
    // read only by the commands that confirm an identity.
    expect(
      parseArguments([
        "team",
        "trust",
        "user",
        "--fingerprint",
        "1A2B3C4D 5e6f7a8b 9c0d1e2f 3a4b5c6d 7e8f9a0b",
      ]).fingerprint,
    ).toBe("1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b");
    expect(
      parseArguments([
        "team",
        "share-keys",
        "octocat",
        `--fingerprint=${"ab".repeat(20)}`,
      ]).fingerprint,
    ).toBe("ab".repeat(20));
    expect(() =>
      parseArguments(["team", "trust", "user", "--fingerprint", "abc"]),
    ).toThrow("--fingerprint takes the 40 hex digits");
    expect(() =>
      parseArguments(["pull", "--fingerprint", "ab".repeat(20)]),
    ).toThrow("--fingerprint doesn\'t work with dotrelay pull");
    expect(parseArguments(["device", "list"]).subcommand).toBe("list");
    expect(
      parseArguments(["team", "decline", "Payments", "--no-input", "--force"])
        .positionals,
    ).toEqual(["Payments"]);
    expect(() => parseArguments(["team", "decline"])).toThrow(
      "Usage: dotrelay team decline <invitation-id-or-team>",
    );
    expect(() =>
      parseArguments(["team", "decline", "Payments", "--team", "t"]),
    ).toThrow();
  });

  test("run takes the command after -- and leaves its flags alone", () => {
    const parsed = parseArguments([
      "run",
      "--environment",
      "production",
      "--",
      "node",
      "server.js",
      "--port",
      "3000",
      "--insecure",
    ]);
    expect(parsed.environment).toBe("production");
    expect(parsed.positionals).toEqual([
      "node",
      "server.js",
      "--port",
      "3000",
      "--insecure",
    ]);
    expect(() => parseArguments(["run", "node", "server.js"])).toThrow(
      "Put the command to start after --",
    );
    expect(() => parseArguments(["run"])).toThrow(
      "Put the command to start after --",
    );
    expect(() => parseArguments(["run", "--json", "--", "x"])).toThrow(
      "--json doesn\'t work with dotrelay run",
    );
    // The child's own flags are never DotRelay's forbidden flags.
    expect(() =>
      rejectForbiddenFlags(["run", "--", "curl", "--insecure"]),
    ).not.toThrow();
    expect(() => rejectForbiddenFlags(["pull", "--insecure"])).toThrow(
      "DotRelay doesn't accept --insecure",
    );
    expect(ownArguments(["run", "-p", "--", "--help"])).toEqual(["run", "-p"]);
  });

  test("--allow-env names process-control Variables for run and export only", () => {
    const parsed = parseArguments([
      "run",
      "--allow-env",
      "NODE_OPTIONS",
      "--allow-env=PATH",
      "--",
      "node",
      "app.js",
    ]);
    expect(parsed.allowedEnvironmentNames).toEqual(["NODE_OPTIONS", "PATH"]);
    expect(
      parseArguments(["export", "--format", "shell", "--allow-env", "PATH"])
        .allowedEnvironmentNames,
    ).toEqual(["PATH"]);
    expect(parseArguments(["run", "--", "x"]).allowedEnvironmentNames).toEqual(
      [],
    );
    expect(() =>
      parseArguments(["run", "--allow-env", "NOT-A-NAME", "--", "x"]),
    ).toThrow("--allow-env takes a variable name");
    expect(() => parseArguments(["pull", "--allow-env", "PATH"])).toThrow(
      "--allow-env doesn\'t work with dotrelay pull",
    );
  });

  test("export validates --format", () => {
    expect(parseArguments(["export"]).format).toBeUndefined();
    expect(parseArguments(["export", "--format", "shell"]).format).toBe(
      "shell",
    );
    expect(() => parseArguments(["export", "--format", "yaml"])).toThrow(
      "--format must be dotenv, json or shell.",
    );
    expect(() => parseArguments(["pull", "--format", "json"])).toThrow(
      "--format doesn\'t work with dotrelay pull",
    );
  });
});
