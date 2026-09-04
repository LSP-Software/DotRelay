export const EXIT_CODES = Object.freeze({
  success: 0,
  invocation: 2,
  incompleteExport: 3,
  conflict: 4,
  crypto: 5,
  authentication: 6,
  transient: 7,
  localIo: 8,
});

export type CliErrorCategory =
  | "invocation"
  | "incomplete-export"
  | "conflict"
  | "crypto"
  | "authentication"
  | "transient"
  | "local-io";

const categoryExitCode: Record<CliErrorCategory, number> = {
  invocation: EXIT_CODES.invocation,
  "incomplete-export": EXIT_CODES.incompleteExport,
  conflict: EXIT_CODES.conflict,
  crypto: EXIT_CODES.crypto,
  authentication: EXIT_CODES.authentication,
  transient: EXIT_CODES.transient,
  "local-io": EXIT_CODES.localIo,
};

const safeDiagnosticKeys = new Set([
  "count",
  "variableCount",
  "sharedValueCount",
  "userDefinedValueCount",
  "missingCount",
  "changedCount",
]);
const safeDiagnosticNumericKeys = new Set(safeDiagnosticKeys);

const safeDiagnosticCodes = new Set([
  "archived_resource",
  "auth_response_invalid",
  "authentication_required",
  "browser_open_failed",
  "capabilities_invalid",
  "capabilities_unavailable",
  "command_unavailable",
  "conflict",
  "context_read_failed",
  "context_write_failed",
  "credential_store_delete_failed",
  "credential_store_unavailable",
  "credential_store_unsupported",
  "credential_store_write_failed",
  "device_authorization_denied",
  "device_authorization_expired",
  "device_authorization_failed",
  "device_authorization_timeout",
  "device_authorization_unavailable",
  "environment_ambiguous",
  "environment_not_found",
  "incomplete-export",
  "invalid_id",
  "invalid_request",
  "invitation_expired",
  "invocation",
  "local-io",
  "membership_not_key_provisioned",
  "missing_values",
  "operation_conflict",
  "output_write_failed",
  "profile_catalog_invalid",
  "profile_catalog_read_failed",
  "profile_catalog_write_failed",
  "profile_selection_invalid",
  "repository_ambiguous",
  "repository_detection_failed",
  "repository_missing",
  "repository_resolution_failed",
  "request_failed",
  "recovery_kit_invalid",
  "resource_not_found",
  "response_invalid",
  "response_too_large",
  "rotation_required",
  "service_unavailable",
  "session_invalid",
  "staged_object_missing",
  "staging_expired",
  "stale_epoch",
  "stale_generation",
  "stale_head",
  "state_conflict",
  "transient",
  "unsafe_stdout",
  "unsupported_api_version",
  "unsupported_media_type",
  "unexpected_failure",
]);

export const sanitizeCliText = (detail: string): string =>
  Array.from(detail)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint === 9 ||
        codePoint === 10 ||
        codePoint === 13 ||
        !(codePoint < 32 || (codePoint >= 127 && codePoint <= 159))
      );
    })
    .join("");

export class CliError extends Error {
  readonly category: CliErrorCategory;
  readonly code: string;
  readonly details: Readonly<Record<string, string | number | boolean>>;

  constructor(
    category: CliErrorCategory,
    detail: string,
    details: Readonly<Record<string, string | number | boolean>> = {},
    code: string = category,
  ) {
    super(detail);
    this.name = "CliError";
    this.category = category;
    this.code = code;
    this.details = details;
  }

  get exitCode(): number {
    return categoryExitCode[this.category];
  }
}

export class CliInvocationError extends CliError {
  constructor(detail: string) {
    super("invocation", detail);
    this.name = "CliInvocationError";
  }
}

export type CliDiagnostic = Readonly<{
  readonly ok: false;
  readonly category: CliErrorCategory;
  readonly code: string;
  readonly detail: string;
  readonly exitCode: number;
  readonly [key: string]: string | number | boolean;
}>;

const safeDiagnosticCategory = (
  category: CliErrorCategory,
): CliErrorCategory => (category === "crypto" ? "transient" : category);

const safeDiagnosticExitCode = (
  category: CliErrorCategory,
  exitCode: number,
): number => (category === "crypto" ? EXIT_CODES.transient : exitCode);

export const diagnosticForError = (error: unknown): CliDiagnostic => {
  if (error instanceof CliError) {
    const safeDetails = Object.fromEntries(
      Object.entries(error.details).filter(([key, value]) => {
        if (!safeDiagnosticKeys.has(key)) return false;
        return (
          safeDiagnosticNumericKeys.has(key) &&
          typeof value === "number" &&
          Number.isInteger(value) &&
          value >= 0 &&
          value <= 1_000_000_000
        );
      }),
    );
    return {
      ok: false,
      category: safeDiagnosticCategory(error.category),
      code: safeDiagnosticCodes.has(error.code)
        ? error.code
        : "unexpected_failure",
      detail: "The command could not complete.",
      ...safeDetails,
      exitCode: safeDiagnosticExitCode(error.category, error.exitCode),
    };
  }
  return {
    ok: false,
    category: "local-io",
    code: "unexpected_failure",
    detail: "The command could not complete.",
    exitCode: EXIT_CODES.localIo,
  };
};
