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
});
