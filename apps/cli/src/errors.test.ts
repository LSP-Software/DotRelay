import { describe, expect, test } from "bun:test";
import { ProtocolTransportError } from "@dotrelay/client";
import {
  ContractError,
  createProblem,
  type ProblemCode,
} from "@dotrelay/contracts";
import {
  CliError,
  type CliErrorCategory,
  CliInvocationError,
  detailForProblem,
  diagnosticForError,
  EXIT_CODES,
  humanDetailForError,
  sanitizeCliText,
} from "./errors";

describe("CLI diagnostics", () => {
  test("shows the sanitized CliError next action by default", () => {
    const diagnostic = diagnosticForError(
      new CliInvocationError("no Team is available for this Project"),
    );
    expect(diagnostic.detail).toBe("no Team is available for this Project");
    expect(diagnostic.code).toBe("invocation");
  });

  test("repository access denial gives recovery steps in human and JSON output", () => {
    const errors = [
      new ContractError("repository_access_denied"),
      new ProtocolTransportError(createProblem("repository_access_denied")),
    ];
    for (const error of errors) {
      const diagnostic = diagnosticForError(error);
      expect(diagnostic).toMatchObject({
        category: "authentication",
        code: "repository_access_denied",
        exitCode: EXIT_CODES.authentication,
      });
      expect(diagnostic.detail).toContain(
        "Check the repository name and your GitHub access",
      );
      expect(diagnostic.detail).toContain(
        "https://github.com/settings/applications",
      );
      expect(diagnostic.detail).toContain("organization owner");
      expect(diagnostic.detail).toContain("SSO");
      expect(diagnostic.detail).toContain("sign out of the DotRelay web app");
      expect(diagnostic.detail).toContain("retry your command");
      expect(diagnostic.detail.length).toBeLessThanOrEqual(512);
      expect(humanDetailForError(error)).toBe(diagnostic.detail);
      expect(
        diagnosticForError(
          new CliError(
            "authentication",
            diagnostic.detail,
            {},
            diagnostic.code,
          ),
        ).detail,
      ).toBe(diagnostic.detail);
    }
  });

  test("keeps unknown errors opaque without --debug", () => {
    expect(diagnosticForError(new Error("bearer=secret")).detail).toBe(
      "The command could not complete.",
    );
  });

  test("prints the Error message on human stderr", () => {
    expect(
      humanDetailForError(new Error("publication has no changed lanes")),
    ).toBe("publication has no changed lanes");
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

  test("keeps the crypto category and exit code for integrity failures", () => {
    for (const code of [
      "trusted_head_conflict",
      "trusted_head_invalid",
      "device_bundle_invalid",
      "recovery_kit_invalid",
    ]) {
      const diagnostic = diagnosticForError(
        new CliError("crypto", "the integrity check failed", {}, code),
      );
      expect(diagnostic).toMatchObject({
        ok: false,
        category: "crypto",
        code,
        detail: "the integrity check failed",
        exitCode: EXIT_CODES.crypto,
      });
    }
  });

  test("keeps the category even when a crypto code is unrecognized", () => {
    const diagnostic = diagnosticForError(
      new CliError("crypto", "the integrity check failed", {}, "no_such_code"),
    );
    expect(diagnostic.category).toBe("crypto");
    expect(diagnostic.code).toBe("unexpected_failure");
    expect(diagnostic.exitCode).toBe(EXIT_CODES.crypto);
  });

  test("keeps every documented problem code intact", () => {
    const known: ReadonlyArray<readonly [CliErrorCategory, string]> = [
      ["authentication", "device_not_active"],
      ["authentication", "device_mismatch"],
      ["authentication", "profile_mismatch"],
      ["authentication", "user_mismatch"],
      ["authentication", "forbidden"],
      ["crypto", "artifact_invalid"],
      ["crypto", "capabilities_invalid"],
      ["crypto", "crypto"],
      ["crypto", "crypto_provider_unavailable"],
      ["crypto", "device_bundle_invalid"],
      ["crypto", "enrollment_binding_mismatch"],
      ["crypto", "enrollment_certificate_invalid"],
      ["crypto", "invalid_crypto_object"],
      ["crypto", "trusted_head_conflict"],
      ["crypto", "trusted_head_invalid"],
      ["crypto", "unsupported_crypto_runtime"],
      ["crypto", "unsupported_crypto_suite"],
      ["conflict", "environment_context_missing"],
      ["conflict", "recovery_generation_invalid"],
      ["conflict", "recovery_requires_no_active_device"],
      ["conflict", "rollback_target_unavailable"],
      ["conflict", "rollback_variable_absent"],
      ["incomplete-export", "missing_values"],
      ["invocation", "invalid_id"],
      ["invocation", "payload_too_large"],
      ["invocation", "publication_invalid"],
      ["local-io", "artifact_read_failed"],
      ["local-io", "artifact_too_large"],
      ["local-io", "credential_store_invalid"],
      ["local-io", "trusted_head_read_failed"],
      ["transient", "device_enrollment_unavailable"],
      ["transient", "grant_bootstrap_unavailable"],
      ["transient", "peer_share_failed"],
      ["transient", "rate_limited"],
      ["transient", "rate_limit_unavailable"],
      ["transient", "service_unavailable"],
    ];
    for (const [category, code] of known) {
      const error = new CliError(category, "the command failed", {}, code);
      const diagnostic = diagnosticForError(error);
      expect(diagnostic.category).toBe(category);
      expect(diagnostic.code).toBe(code);
      expect(diagnostic.exitCode).toBe(error.exitCode);
    }
  });

  test("classifies ContractError failures by their problem code", () => {
    const cases: ReadonlyArray<
      readonly [ProblemCode, CliErrorCategory, number]
    > = [
      ["invalid_crypto_object", "crypto", EXIT_CODES.crypto],
      ["unsupported_crypto_suite", "crypto", EXIT_CODES.crypto],
      ["unsupported_crypto_runtime", "crypto", EXIT_CODES.crypto],
      ["stale_head", "conflict", EXIT_CODES.conflict],
      ["device_not_active", "authentication", EXIT_CODES.authentication],
      ["service_unavailable", "transient", EXIT_CODES.transient],
    ];
    for (const [code, category, exitCode] of cases) {
      const diagnostic = diagnosticForError(new ContractError(code));
      expect(diagnostic).toMatchObject({
        ok: false,
        category,
        code,
        exitCode,
      });
      expect(diagnostic.detail).toBe(detailForProblem(code));
    }
  });

  test("classifies protocol transport errors by their problem code", () => {
    const transport = (code: ProblemCode) =>
      new ProtocolTransportError(createProblem(code));
    const rejected = diagnosticForError(transport("device_not_active"));
    expect(rejected).toMatchObject({
      ok: false,
      category: "authentication",
      code: "device_not_active",
      exitCode: EXIT_CODES.authentication,
    });
    const conflicted = diagnosticForError(transport("stale_head"));
    expect(conflicted.category).toBe("conflict");
    expect(conflicted.code).toBe("stale_head");
    expect(conflicted.exitCode).toBe(EXIT_CODES.conflict);
    const unavailable = diagnosticForError(transport("service_unavailable"));
    expect(unavailable.category).toBe("transient");
    expect(unavailable.exitCode).toBe(EXIT_CODES.transient);
    const cryptoRejection = diagnosticForError(
      transport("invalid_crypto_object"),
    );
    expect(cryptoRejection.category).toBe("crypto");
    expect(cryptoRejection.exitCode).toBe(EXIT_CODES.crypto);
  });

  test("classifies unwrapped crypto runtime failures without revealing detail", () => {
    const failures: readonly Error[] = [
      Object.assign(new Error("error:06065080:digital envelope routines"), {
        code: "ERR_OSSL_EVP_R_BAD_DECRYPT",
      }),
      Object.assign(new Error("decryption failed"), {
        name: "OperationError",
        code: 22,
      }),
    ];
    for (const error of failures) {
      const diagnostic = diagnosticForError(error);
      expect(diagnostic).toMatchObject({
        ok: false,
        category: "crypto",
        code: "crypto",
        exitCode: EXIT_CODES.crypto,
      });
      // Without --debug the raw runtime message never reaches the diagnostic.
      expect(diagnostic.detail).toBe("The command could not complete.");
      expect(JSON.stringify(diagnostic)).not.toContain("digital envelope");
      expect(JSON.stringify(diagnostic)).not.toContain("decryption failed");
      // --debug opts into the sanitized operational message.
      expect(diagnosticForError(error, { debug: true }).detail).toBe(
        sanitizeCliText(error.message),
      );
    }
  });

  test("keeps unknown non-crypto failures local and opaque", () => {
    const diagnostic = diagnosticForError(new Error("unexpected boom"));
    expect(diagnostic).toMatchObject({
      ok: false,
      category: "local-io",
      code: "unexpected_failure",
      exitCode: EXIT_CODES.localIo,
    });
    expect(diagnostic.detail).toBe("The command could not complete.");
  });

  test("human and JSON diagnostics agree on the next action", () => {
    const errors: unknown[] = [
      new CliError(
        "crypto",
        "the local trusted head record is invalid",
        {},
        "trusted_head_invalid",
      ),
      new CliError(
        "authentication",
        "this Device is not active; run dotrelay device enroll to re-authorize it",
        {},
        "device_not_active",
      ),
      new ContractError("invalid_crypto_object"),
      new ProtocolTransportError(createProblem("device_not_active")),
      Object.assign(new Error("error:06065080:digital envelope routines"), {
        code: "ERR_OSSL_EVP_R_BAD_DECRYPT",
      }),
    ];
    for (const error of errors) {
      for (const debug of [false, true]) {
        expect(humanDetailForError(error, { debug })).toBe(
          diagnosticForError(error, { debug }).detail,
        );
      }
    }
    // The raw crypto runtime text stays out of human stderr without --debug.
    const runtimeError = Object.assign(
      new Error("error:06065080:digital envelope routines"),
      { code: "ERR_OSSL_EVP_R_BAD_DECRYPT" },
    );
    expect(humanDetailForError(runtimeError)).toBe(
      "The command could not complete.",
    );
  });
});
