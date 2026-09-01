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
});
