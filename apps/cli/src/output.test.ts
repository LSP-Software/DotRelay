import { describe, expect, test } from "bun:test";
import { CliError, diagnosticForError, EXIT_CODES } from "./errors";
import { assertSafeStdout, atomicWriteProtectedFile } from "./output";

describe("CLI output safety", () => {
  test("requires reveal for terminal stdout", () => {
    expect(() => assertSafeStdout({ requested: true, terminal: true })).toThrow(
      "--reveal",
    );
    expect(() =>
      assertSafeStdout({ requested: true, terminal: true, reveal: true }),
    ).not.toThrow();
  });

  test("maps failures to stable redacted diagnostics", () => {
    const diagnostic = diagnosticForError(
      new CliError("conflict", "stale head", { count: 1 }),
    );
    expect(diagnostic).toEqual({
      ok: false,
      category: "conflict",
      code: "conflict",
      detail: "The command could not complete.",
      count: 1,
      exitCode: EXIT_CODES.conflict,
    });
    const hostile = diagnosticForError(
      new CliError("local-io", "bearer=secret private-key=ciphertext"),
    );
    expect(hostile.detail).toBe("The command could not complete.");
    expect(JSON.stringify(hostile)).not.toContain("secret");
    expect(JSON.stringify(hostile)).not.toContain("private-key");
    expect(JSON.stringify(diagnostic)).not.toContain("value");
    const secret = diagnosticForError(
      new CliError("local-io", "operation failed", {
        value: "secret",
        token: "bearer",
        profile: "relay",
        repository: "LSP-Software/DotRelay",
        count: "bearer-secret" as never,
      }),
    );
    expect(JSON.stringify(secret)).not.toContain("secret");
    expect(JSON.stringify(secret)).not.toContain("bearer");
    expect(JSON.stringify(secret)).not.toContain("LSP-Software/DotRelay");
    expect(JSON.stringify(secret)).not.toContain("bearer-secret");
    const unknownCode = diagnosticForError(
      new CliError("local-io", "failure", {}, "domain-id-secret"),
    );
    expect(unknownCode.code).toBe("unexpected_failure");
    const terminalControl = diagnosticForError(
      new CliError("local-io", "ordinary\u001b[31m text\b"),
    );
    expect(terminalControl.detail).toBe("The command could not complete.");
    expect(terminalControl.detail).not.toContain("\u001b");
    expect(terminalControl.detail).not.toContain("\b");
  });

  test("atomically writes a protected output file", async () => {
    const file = `${import.meta.dir}/.tmp-output-${crypto.randomUUID()}`;
    try {
      await atomicWriteProtectedFile(file, "KEY=value\n");
      expect(await Bun.file(file).text()).toBe("KEY=value\n");
      if (process.platform !== "win32")
        expect((await Bun.file(file).stat()).mode & 0o777).toBe(0o600);
    } finally {
      await (await import("node:fs/promises"))
        .unlink(file)
        .catch(() => undefined);
    }
  });
});
