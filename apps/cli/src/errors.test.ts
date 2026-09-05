import { describe, expect, test } from "bun:test";
import { CliInvocationError, diagnosticForError } from "./errors";

describe("CLI diagnostics", () => {
  test("keeps operational detail opaque by default", () => {
    const diagnostic = diagnosticForError(
      new CliInvocationError("no Team is available for this Project"),
    );
    expect(diagnostic.detail).toBe("The command could not complete.");
    expect(diagnostic.code).toBe("invocation");
  });

  test("exposes sanitized CliError detail when debug is enabled", () => {
    const diagnostic = diagnosticForError(
      new CliInvocationError("no Team is available for this Project"),
      { debug: true },
    );
    expect(diagnostic.detail).toBe("no Team is available for this Project");
  });
});
