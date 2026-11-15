import { describe, expect, test } from "bun:test";
import { CliError, diagnosticForError, EXIT_CODES } from "./errors";
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSafeStdout,
  atomicWriteProtectedFile,
  previousFilePaths,
} from "./output";

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
    const hostile = diagnosticForError(
      new CliError("local-io", "bearer=secret private-key=ciphertext", {
        value: "secret",
        token: "bearer",
      }),
    );
    expect(hostile.detail).toBe("bearer=secret private-key=ciphertext");
    expect(JSON.stringify(hostile)).not.toContain('"value"');
    expect(JSON.stringify(hostile)).not.toContain('"token"');
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
    for (const code of [
      "crypto_provider_unavailable",
      "invalid_crypto_object",
      "unsupported_crypto_runtime",
      "unsupported_crypto_suite",
      "crypto",
    ]) {
      // Integrity and compatibility failures keep the documented crypto
      // category and exit code 5; only codes the CLI never raises are
      // masked, and even then the category stays actionable.
      const diagnostic = diagnosticForError(
        new CliError("crypto", "cryptographic component failure", {}, code),
      );
      expect(diagnostic.category).toBe("crypto");
      expect(diagnostic.code).toBe(code);
      expect(diagnostic.exitCode).toBe(EXIT_CODES.crypto);
    }
    const unknownCryptoCode = diagnosticForError(
      new CliError("crypto", "cryptographic component failure", {}, "nope"),
    );
    expect(unknownCryptoCode.category).toBe("crypto");
    expect(unknownCryptoCode.code).toBe("unexpected_failure");
    expect(unknownCryptoCode.exitCode).toBe(EXIT_CODES.crypto);
    const terminalControl = diagnosticForError(
      new CliError("local-io", "ordinary\u001b[31m text\b"),
    );
    expect(terminalControl.detail).toBe("ordinary[31m text");
    expect(terminalControl.detail).not.toContain("\u001b");
    expect(terminalControl.detail).not.toContain("\b");
    expect(
      diagnosticForError(new Error("ordinary\u001b[31m secret")).detail,
    ).toBe("The command could not complete.");
  });

  test("atomically writes a protected output file", async () => {
    const file = `${import.meta.dir}/.tmp-output-${crypto.randomUUID()}`;
    try {
      await atomicWriteProtectedFile(file, "KEY=value\n");
      expect(await Bun.file(file).text()).toBe("KEY=value\n");
      if (process.platform !== "win32")
        expect((await Bun.file(file).stat()).mode & 0o777).toBe(0o600);
    } finally {
      await (
        await import("node:fs/promises")
      )
        .unlink(file)
        .catch(() => undefined);
    }
  });

  const scratch = async () => mkdtemp(join(tmpdir(), "dotrelay-output-"));

  test("writes through a symlinked output instead of replacing the link", async () => {
    const directory = await scratch();
    try {
      const target = join(directory, "shared.env");
      const link = join(directory, ".env");
      await writeFile(target, "KEY=old\n");
      await symlink(target, link);
      await atomicWriteProtectedFile(link, "KEY=new\n", {
        retainPrevious: true,
        followSymlink: true,
      });
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await readFile(target, "utf8")).toBe("KEY=new\n");
      expect(await readFile(`${link}.previous`, "utf8")).toBe("KEY=old\n");
      if (process.platform !== "win32")
        expect((await stat(target)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps a rotation of earlier copies and never retains a duplicate", async () => {
    const directory = await scratch();
    try {
      const file = join(directory, ".env");
      const [newest, older, oldest] = previousFilePaths(file);
      await writeFile(file, "# my notes\nKEY=1\n");
      await atomicWriteProtectedFile(file, "KEY='1'\n", {
        retainPrevious: true,
      });
      // Writing the same content again must not push the commented
      // original out of the newest slot.
      await atomicWriteProtectedFile(file, "KEY='1'\n", {
        retainPrevious: true,
      });
      expect(await readFile(`${newest}`, "utf8")).toBe("# my notes\nKEY=1\n");
      await atomicWriteProtectedFile(file, "KEY='2'\n", {
        retainPrevious: true,
      });
      await atomicWriteProtectedFile(file, "KEY='3'\n", {
        retainPrevious: true,
      });
      expect(await readFile(`${newest}`, "utf8")).toBe("KEY='2'\n");
      expect(await readFile(`${older}`, "utf8")).toBe("KEY='1'\n");
      expect(await readFile(`${oldest}`, "utf8")).toBe("# my notes\nKEY=1\n");
      await atomicWriteProtectedFile(file, "KEY='4'\n", {
        retainPrevious: true,
      });
      expect(await readFile(`${oldest}`, "utf8")).toBe("KEY='1'\n");
      if (process.platform !== "win32")
        for (const path of [newest, older, oldest])
          expect((await stat(`${path}`)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
