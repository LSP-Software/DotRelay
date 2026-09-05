import { describe, expect, test } from "bun:test";
import { CliInvocationError, diagnosticForError, humanDetailForError } from "./errors";

describe("CLI diagnostics", () => {
  test("shows the sanitized CliError next action by default", () => {
    const diagnostic = diagnosticForError(
      new CliInvocationError("no Team is available for this Project"),
    );
    expect(diagnostic.detail).toBe("no Team is available for this Project");
    expect(diagnostic.code).toBe("invocation");
  });

  test("keeps unknown errors opaque without --debug", () => {
    expect(diagnosticForError(new Error("bearer=secret")).detail).toBe(
      "The command could not complete.",
    );
  });

  test("prints the Error message on human stderr", () => {
    expect(humanDetailForError(new Error("publication has no changed lanes"))).toBe(
      "publication has no changed lanes",
    );
    expect(
      humanDetailForError(new CliInvocationError("no Team is available")),
    ).toBe("no Team is available");
  });

  test("exposes sanitized CliError detail when debug is enabled", () => {
    const diagnostic = diagnosticForError(
      new CliInvocationError("no Team is available for this Project"),
      { debug: true },
    );
    expect(diagnostic.detail).toBe("no Team is available for this Project");
  });
});
