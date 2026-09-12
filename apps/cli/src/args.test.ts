import { describe, expect, test } from "bun:test";
import { CliInvocationError, parseArguments } from "./args";

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

  test("requires an exact Server Profile id for profile trust confirmation", () => {
    expect(
      parseArguments([
        "profile",
        "add",
        "work",
        "https://relay.example",
        "--accept-profile",
        "00000000-0000-4000-8000-000000000042",
      ]).acceptProfile,
    ).toBe("00000000-0000-4000-8000-000000000042");
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
      ]).variableIds,
    ).toEqual(["22222222-2222-4222-8222-222222222222"]);
    expect(() =>
      parseArguments(["rollback", "11111111-1111-4111-8111-111111111111"]),
    ).toThrow("--variable");
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
    expect(
      parseArguments(["device", "backup", "--output", "recovery.kit"]),
    ).toMatchObject({
      command: "device",
      subcommand: "backup",
      output: "recovery.kit",
    });
    expect(
      parseArguments(["device", "recover", "--from", "recovery.kit"]),
    ).toMatchObject({
      command: "device",
      subcommand: "recover",
      from: "recovery.kit",
    });
  });

  test("requires explicit handoff files in the trust commands", () => {
    expect(() => parseArguments(["device", "approve"])).toThrow("--from");
    expect(() => parseArguments(["device", "backup"])).toThrow("--output");
    expect(() => parseArguments(["device", "recover"])).toThrow("--from");
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
        "backup",
        "--output",
        "recovery.kit",
        "--no-input",
        "--force",
      ]).force,
    ).toBe(true);
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
      "diff takes no positional arguments but received 1; use --environment extra instead; usage: dotrelay diff",
    );
  });

  test("rejects unexpected positionals with a correction and usage", () => {
    expect(() => parseArguments(["pull", "production"])).toThrow(
      "pull takes no positional arguments but received 1; use --environment production instead; usage: dotrelay pull",
    );
    expect(() => parseArguments(["pull", "a", "b"])).toThrow(
      "pull takes no positional arguments but received 2; usage: dotrelay pull",
    );
    expect(() => parseArguments(["push", "extra"])).toThrow(
      "usage: dotrelay push",
    );
    expect(() => parseArguments(["login", "extra"])).toThrow(
      "usage: dotrelay login",
    );
    expect(() => parseArguments(["logout", "extra"])).toThrow(
      "usage: dotrelay logout",
    );
    expect(() => parseArguments(["status", "extra"])).toThrow(
      "usage: dotrelay status",
    );
    expect(() => parseArguments(["context", "extra"])).toThrow(
      "usage: dotrelay context",
    );
    expect(() => parseArguments(["history", "extra"])).toThrow(
      "usage: dotrelay history",
    );
    expect(() =>
      parseArguments(["setup", "https://a.example", "https://b.example"]),
    ).toThrow("usage: dotrelay setup <origin>");
    expect(() =>
      parseArguments([
        "rollback",
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "--variable",
        "33333333-3333-4333-8333-333333333333",
      ]),
    ).toThrow("usage: dotrelay rollback");
  });

  test("rejects mutually exclusive pull output combinations", () => {
    expect(() =>
      parseArguments(["pull", "--stdout", "--output", ".env"]),
    ).toThrow(
      "pull --stdout and --output are mutually exclusive; use either `dotrelay pull --stdout` or `dotrelay pull --output <file>`",
    );
    expect(() => parseArguments(["pull", "--stdout", "--json"])).toThrow(
      "pull --stdout and --json are mutually exclusive",
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
      "--limit is not supported by status",
    );
    expect(() => parseArguments(["status", "--no-open"])).toThrow("--no-open");
    expect(() => parseArguments(["login", "--environment", "prod"])).toThrow(
      "--environment is not supported by login",
    );
    expect(() => parseArguments(["logout", "--no-input"])).toThrow(
      "--no-input",
    );
    expect(() =>
      parseArguments(["setup", "https://relay.example", "--profile", "relay"]),
    ).toThrow("--profile is not supported by setup");
    expect(() => parseArguments(["help", "--json"])).toThrow("--json");
    expect(() => parseArguments(["device", "backup", "--from", "kit"])).toThrow(
      "--from is not supported by device backup",
    );
    expect(parseArguments(["history", "--limit", "25"]).limit).toBe(25);
    expect(parseArguments(["pull", "--limit", "25"]).limit).toBe(25);
    expect(() => parseArguments(["status", "--limit", "999"])).toThrow(
      "--limit is not supported by status",
    );
    expect(() => parseArguments(["history", "--limit", "0"])).toThrow(
      "--limit must be an integer from 1 to 256",
    );
    expect(() => parseArguments(["history", "--limit", "257"])).toThrow(
      "--limit must be an integer from 1 to 256",
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
      "usage: dotrelay pull",
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
    expect(
      parseArguments([
        "setup",
        "https://relay.example",
        "--accept-profile",
        "00000000-0000-4000-8000-000000000042",
      ]).acceptProfile,
    ).toBe("00000000-0000-4000-8000-000000000042");
  });
});
