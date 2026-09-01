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
      detail: "stale head",
      count: 1,
      exitCode: EXIT_CODES.conflict,
    });
    expect(JSON.stringify(diagnostic)).not.toContain("value");
    const secret = diagnosticForError(
      new CliError("local-io", "operation failed", {
        value: "secret",
        token: "bearer",
      }),
    );
    expect(JSON.stringify(secret)).not.toContain("secret");
    expect(JSON.stringify(secret)).not.toContain("bearer");
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
