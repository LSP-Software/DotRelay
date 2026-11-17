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
  describeWait,
  detailForProblem,
  diagnosticForError,
  EXIT_CODES,
  humanDetailForError,
  presentationForError,
  repositoryAccessDeniedDetail,
  sanitizeCliLine,
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
      expect(diagnostic.detail).toContain("Check the repository name");
      expect(diagnostic.detail).toContain(
        "Install this server's DotRelay GitHub App",
      );
      expect(diagnostic.detail).toContain(
        "https://github.com/settings/installations",
      );
      expect(diagnostic.detail).not.toContain("OAuth");
      expect(diagnostic.detail).toContain("organization owner");
      expect(diagnostic.detail).toContain("SSO");
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

  test("repository access denial links the server's GitHub App install page", () => {
    const installUrl = `https://github.com/apps/${"a".repeat(100)}/installations/new`;
    const detail = repositoryAccessDeniedDetail(installUrl);
    expect(detail).toContain(
      `Install the DotRelay GitHub App and choose this repository: ${installUrl}`,
    );
    expect(detail).not.toContain("Ask the server operator");
    expect(detail).not.toContain("OAuth");
    const diagnostic = diagnosticForError(
      new CliError("authentication", detail, {}, "repository_access_denied"),
    );
    // Even the longest slug GitHub allows fits the diagnostic detail limit.
    expect(diagnostic.detail).toBe(detail);
    expect(repositoryAccessDeniedDetail().length).toBeLessThanOrEqual(512);
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
      "account_key_transfer_invalid",
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
      ["authentication", "account_key_not_unlocked"],
      ["conflict", "recovery_wrapper_missing"],
      ["conflict", "rollback_target_unavailable"],
      ["conflict", "rollback_variable_absent"],
      ["conflict", "baseline_unverifiable"],
      ["conflict", "variable_conflict"],
      ["incomplete-export", "missing_values"],
      ["local-io", "baseline_invalid"],
      ["incomplete-export", "unreadable_manifest"],
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
      ["membership_not_active", "conflict", EXIT_CODES.conflict],
      ["membership_not_key_provisioned", "conflict", EXIT_CODES.conflict],
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
    const inactive = diagnosticForError(transport("membership_not_active"));
    expect(inactive.category).toBe("conflict");
    expect(inactive.code).toBe("membership_not_active");
    expect(inactive.exitCode).toBe(EXIT_CODES.conflict);
    // A pending Member needs keys shared, not a re-add; a removed one needs
    // a new invitation. The problem cannot tell them apart, so both repairs
    // are named, and neither claims a teammate's pull can share keys.
    expect(inactive.detail).toContain('choose "Share project keys" for you');
    expect(inactive.detail).toContain("dotrelay team share-keys");
    expect(inactive.detail).toContain("invite you again");
    expect(inactive.detail).not.toContain("re-add");
    expect(inactive.detail.length).toBeLessThan(512);
    // A Membership waiting for keys has its own code and names only the
    // key share, not a new invitation.
    const waiting = diagnosticForError(
      transport("membership_not_key_provisioned"),
    );
    expect(waiting.category).toBe("conflict");
    expect(waiting.code).toBe("membership_not_key_provisioned");
    expect(waiting.detail).toContain("dotrelay team share-keys");
    expect(waiting.detail).not.toContain("invite you again");
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

describe("problem codes added with Membership periods and rate limits", () => {
  const transport = (
    code: ProblemCode,
    details?: Parameters<typeof createProblem>[1],
  ) => new ProtocolTransportError(createProblem(code, details));

  test("authored_at_out_of_range is a conflict that points at the system clock", () => {
    const diagnostic = diagnosticForError(
      transport("authored_at_out_of_range"),
    );
    expect(diagnostic).toMatchObject({
      category: "conflict",
      code: "authored_at_out_of_range",
      exitCode: EXIT_CODES.conflict,
    });
    expect(diagnostic.detail).toContain("system clock");
    expect(
      presentationForError(transport("authored_at_out_of_range")).title,
    ).toBe("Check this machine's clock");
  });

  test("pending_invitation_limit is a conflict that says how to free a slot", () => {
    const diagnostic = diagnosticForError(
      transport("pending_invitation_limit"),
    );
    expect(diagnostic).toMatchObject({
      category: "conflict",
      code: "pending_invitation_limit",
      exitCode: EXIT_CODES.conflict,
    });
    expect(diagnostic.detail).toContain("revoke invitations");
  });

  test("rate_limited names the wait the service asked for", () => {
    const diagnostic = diagnosticForError(
      transport("rate_limited", { retryAfterSeconds: 90 }),
    );
    expect(diagnostic).toMatchObject({
      category: "transient",
      code: "rate_limited",
      retryAfterSeconds: 90,
    });
    expect(diagnostic.detail).toContain("Wait 2 minutes and retry.");
    expect(
      humanDetailForError(transport("rate_limited", { retryAfterSeconds: 1 })),
    ).toContain("Wait 1 second and retry.");
    expect(detailForProblem("rate_limited")).toBe(
      "The server is rate-limiting requests. Wait a moment and retry.",
    );
  });

  test("describes waits in the largest whole unit", () => {
    expect(describeWait(0)).toBe("1 second");
    expect(describeWait(45)).toBe("45 seconds");
    expect(describeWait(60)).toBe("1 minute");
    expect(describeWait(3599)).toBe("60 minutes");
    expect(describeWait(7200)).toBe("2 hours");
  });
});

describe("alpha admission", () => {
  test("names the hosted support address only for the hosted origin", () => {
    const hosted = detailForProblem("alpha_admission_required", {
      origin: "https://api.dotrelay.dev/",
    });
    expect(hosted).toContain(
      "DotRelay is in private alpha and this GitHub account isn't on the list yet. Email support@dotrelay.dev to request access.",
    );
    expect(hosted).toContain("dotrelay logout");
    for (const origin of ["https://dotrelay.example.com", undefined]) {
      const selfHosted = detailForProblem(
        "alpha_admission_required",
        origin === undefined ? {} : { origin },
      );
      expect(selfHosted).toContain("Ask this server's operator for access.");
      expect(selfHosted).not.toContain("support@dotrelay.dev");
      expect(selfHosted).toContain("dotrelay logout");
    }
  });

  test("is an authentication failure with its own title and code", () => {
    const error = new ProtocolTransportError(
      createProblem("alpha_admission_required"),
    );
    expect(diagnosticForError(error)).toMatchObject({
      category: "authentication",
      code: "alpha_admission_required",
      exitCode: EXIT_CODES.authentication,
    });
    const presentation = presentationForError(error);
    expect(presentation.title).toBe("Not on the alpha list yet");
    expect(presentation.fixes).toEqual([
      "To use another GitHub account, run dotrelay logout, then dotrelay login.",
    ]);
  });
});

describe("error cards", () => {
  test("splits a closing Run sentence off as the fix", () => {
    const presentation = presentationForError(
      new CliError(
        "authentication",
        "This machine isn't enrolled. Run dotrelay device enroll.",
        {},
        "device_bundle_missing",
      ),
    );
    expect(presentation.title).toBe("This machine isn't enrolled");
    expect(presentation.detail).toBe("This machine isn't enrolled.");
    expect(presentation.fixes).toEqual(["Run dotrelay device enroll"]);
  });

  test("keeps the command and drops its purpose", () => {
    expect(
      presentationForError(
        new CliInvocationError(
          "DotRelay has no bogus command. Run dotrelay help to see them.",
        ),
      ),
    ).toEqual({
      title: "Check the command",
      detail: "DotRelay has no bogus command.",
      fixes: ["Run dotrelay help"],
    });
  });

  test("still splits the older '; run dotrelay' form", () => {
    const presentation = presentationForError(
      new CliInvocationError(
        "this Device is not active; run dotrelay device enroll to re-authorize it",
      ),
    );
    expect(presentation.detail).toBe("This Device is not active");
    expect(presentation.fixes).toEqual(["Run dotrelay device enroll"]);
  });

  test("keeps dots inside a command, such as an origin", () => {
    expect(
      presentationForError(
        new CliInvocationError(
          "No server is set up. Run dotrelay setup https://api.dotrelay.dev.",
        ),
      ).fixes,
    ).toEqual(["Run dotrelay setup https://api.dotrelay.dev"]);
  });

  test("leaves a sentence with two routes in the detail", () => {
    const detail =
      "This machine isn't enrolled on this server yet. Run dotrelay login, or dotrelay device enroll if you're already signed in.";
    const presentation = presentationForError(new CliInvocationError(detail));
    expect(presentation.detail).toBe(detail);
    expect(presentation.fixes).toEqual([]);
  });

  test("puts a usage line under the detail", () => {
    expect(
      presentationForError(
        new CliInvocationError(
          "dotrelay setup needs the server's address.\nUsage: dotrelay setup <origin>",
        ),
      ),
    ).toEqual({
      title: "Check the command",
      detail: "dotrelay setup needs the server's address.",
      fixes: ["Usage: dotrelay setup <origin>"],
    });
  });
});

describe("CLI text sanitizing", () => {
  test("strips C0, C1, escape sequences and bidi/format characters", () => {
    expect(sanitizeCliText("a\x1b]8;;https://x\x07b\x1b[31mc")).toBe(
      "a]8;;https://xb[31mc",
    );
    expect(sanitizeCliText("a\u009b31mb\u0085c\u007f")).toBe("a31mbc");
    expect(
      sanitizeCliText("a\u200bb\u200fc\u202ad\u202ee\u2066f\u2069g\u200dh"),
    ).toBe("abcdefgh");
    expect(sanitizeCliText("line one\n\tline two\r")).toBe(
      "line one\n\tline two\r",
    );
    expect(sanitizeCliText("café · ✓ 東京")).toBe("café · ✓ 東京");
  });

  test("folds line breaks for single-line values", () => {
    expect(sanitizeCliLine("a\r\nb\tc\x1bd")).toBe("a b cd");
  });
});
