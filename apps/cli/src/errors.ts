import { ProtocolTransportError } from "@dotrelay/client";
import { ContractError } from "@dotrelay/contracts";

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
  "requestPath",
  "correlationId",
  "retryAfterSeconds",
  "count",
  "variableCount",
  "sharedValueCount",
  "userDefinedValueCount",
  "missingCount",
  "changedCount",
]);
const safeDiagnosticNumericKeys = new Set(safeDiagnosticKeys);

// Every intentional problem code the CLI or the protocol can surface. A code
// outside this set is masked to unexpected_failure so an unforeseen value can
// never leak through as a stable category, while the category and exit code
// the command assigned remain actionable.
const safeDiagnosticCodes = new Set([
  "archived_resource",
  "artifact_invalid",
  "artifact_read_failed",
  "artifact_too_large",
  "auth_response_invalid",
  "authentication",
  "authentication_required",
  "browser_open_failed",
  "capabilities_invalid",
  "capabilities_unavailable",
  "command_unavailable",
  "conflict",
  "context_read_failed",
  "context_write_failed",
  "credential_store_delete_failed",
  "credential_store_invalid",
  "credential_store_unavailable",
  "credential_store_write_failed",
  "crypto",
  "crypto_provider_unavailable",
  "deletion_requires_approval",
  "device_authorization_denied",
  "device_authorization_expired",
  "device_authorization_failed",
  "device_authorization_timeout",
  "device_authorization_unavailable",
  "device_bundle_invalid",
  "device_bundle_missing",
  "device_enrollment_failed",
  "device_enrollment_unavailable",
  "device_mismatch",
  "device_not_active",
  "enrollment_binding_mismatch",
  "enrollment_certificate_invalid",
  "environment_ambiguous",
  "environment_context_missing",
  "environment_not_found",
  "forbidden",
  "genesis_exists",
  "git_exclusion_failed",
  "git_tracking_unavailable",
  "github_rate_limited",
  "github_unavailable",
  "grant_bootstrap_failed",
  "grant_bootstrap_unavailable",
  "incomplete-export",
  "input_read_failed",
  "invalid_crypto_object",
  "invalid_id",
  "invalid_request",
  "invitation_expired",
  "invocation",
  "local-io",
  "membership_not_key_provisioned",
  "missing_values",
  "operation_conflict",
  "output_conflict",
  "output_tracked",
  "output_write_failed",
  "payload_too_large",
  "peer_share_failed",
  "profile_catalog_invalid",
  "profile_catalog_read_failed",
  "profile_catalog_write_failed",
  "profile_mismatch",
  "profile_selection_invalid",
  "project_ambiguous",
  "publication_invalid",
  "rate_limited",
  "rate_limit_unavailable",
  "recovery_generation_invalid",
  "recovery_kit_invalid",
  "recovery_requires_no_active_device",
  "repository_access_denied",
  "repository_ambiguous",
  "repository_detection_failed",
  "repository_missing",
  "repository_renamed",
  "request_failed",
  "resource_not_found",
  "response_invalid",
  "response_too_large",
  "rollback_target_unavailable",
  "rollback_variable_absent",
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
  "trusted_head_conflict",
  "trusted_head_invalid",
  "trusted_head_read_failed",
  "trust_failed",
  "unreadable_manifest",
  "unsafe_stdout",
  "unsupported_api_version",
  "unsupported_crypto_runtime",
  "unsupported_crypto_suite",
  "unsupported_media_type",
  "user_mismatch",
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

export const categoryForProblem = (
  code: string,
): "invocation" | "conflict" | "crypto" | "authentication" | "transient" => {
  if (
    code === "authentication_required" ||
    code === "device_not_active" ||
    code === "forbidden" ||
    code === "repository_access_denied"
  )
    return "authentication";
  if (
    [
      "membership_not_key_provisioned",
      "operation_conflict",
      "stale_head",
      "stale_epoch",
      "stale_generation",
      "rotation_required",
      "archived_resource",
      "state_conflict",
      "staged_object_missing",
      "invitation_expired",
      "staging_expired",
      "genesis_exists",
    ].includes(code)
  )
    return "conflict";
  if (
    [
      "invalid_crypto_object",
      "unsupported_media_type",
      "unsupported_api_version",
      "unsupported_crypto_suite",
      "unsupported_crypto_runtime",
      "crypto_provider_unavailable",
    ].includes(code)
  )
    return "crypto";
  if (
    ["invalid_request", "resource_not_found", "payload_too_large"].includes(
      code,
    )
  )
    return "invocation";
  return "transient";
};

export const detailForProblem = (code: string): string => {
  if (code === "authentication_required")
    return "login is required for this Server Profile; run dotrelay login";
  if (code === "device_not_active")
    return "this Device is not active; run dotrelay device enroll to re-authorize it";
  if (code === "forbidden") return "the Server Profile denied the request";
  if (code === "resource_not_found")
    return "the requested resource was not found";
  if (code === "invalid_request")
    return "the Server Profile rejected the request";
  if (code === "payload_too_large") return "the request was too large";
  if (code === "genesis_exists")
    return "this Environment already has a genesis Revision";
  if (code === "repository_access_denied")
    return [
      "DotRelay could not access this GitHub repository.",
      "1. Check the repository name and your GitHub access.",
      "2. Open https://github.com/settings/applications and check the DotRelay GitHub app. For a GitHub App, include the repository in its installation; for an OAuth App, grant organization access. Ask an organization owner to approve access if needed; check SSO too.",
      "3. If access expired, sign out of the DotRelay web app and sign in with GitHub again. Then retry your command.",
    ].join("\n");
  if (code === "github_rate_limited")
    return "GitHub rate-limited the Server Profile's repository lookup; wait for the stated retry window and retry";
  if (code === "github_unavailable")
    return "GitHub could not be reached through the Server Profile; established sync is unaffected, retry once GitHub is available";
  if (code === "rate_limited")
    return "the Server Profile rate-limited the request; wait and retry";
  if (code === "rate_limit_unavailable")
    return "the Server Profile's rate limiter is unavailable; retry later";
  if (categoryForProblem(code) === "conflict")
    return "the requested change conflicts with current Server Profile state";
  if (categoryForProblem(code) === "crypto")
    return "the Server Profile rejected the cryptographic request";
  return "the Server Profile could not complete the request";
};

const capitalize = (text: string): string =>
  text.length === 0 ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

export type ErrorPresentation = Readonly<{
  readonly title: string;
  readonly detail: string;
  readonly fixes: readonly string[];
}>;

const errorTitles: Record<string, string> = {
  authentication_required: "Login required",
  device_not_active: "Device not active",
  device_bundle_missing: "No Device enrolled",
  device_enrollment_failed: "Device enrollment failed",
  device_enrollment_unavailable: "Device enrollment unavailable",
  device_authorization_denied: "Sign-in denied",
  device_authorization_expired: "Sign-in expired",
  device_authorization_timeout: "Sign-in timed out",
  device_authorization_failed: "Sign-in failed",
  forbidden: "Access denied",
  profile_mismatch: "Profile mismatch",
  user_mismatch: "User mismatch",
  repository_access_denied: "GitHub access",
  github_rate_limited: "GitHub rate limit",
  github_unavailable: "GitHub unreachable",
  service_unavailable: "Service unreachable",
  request_failed: "Service error",
  rate_limited: "Rate limited",
  rate_limit_unavailable: "Rate limiter unavailable",
  response_invalid: "Invalid service response",
  response_too_large: "Response too large",
  genesis_exists: "Environment already published",
  output_conflict: "Output file differs",
  output_tracked: "Output is Git-tracked",
  output_write_failed: "Could not write output",
  input_read_failed: "Could not read input",
  deletion_requires_approval: "Approval required",
  unsafe_stdout: "Unsafe output",
  staging_expired: "Staged request expired",
  staged_object_missing: "Staged request missing",
  invitation_expired: "Invitation expired",
  rollback_target_unavailable: "Rollback target unavailable",
  rollback_variable_absent: "Rollback target missing Variables",
  unreadable_manifest: "Unreadable manifest",
  recovery_kit_invalid: "Recovery Kit invalid",
  recovery_requires_no_active_device: "Recovery requires no active Device",
  project_ambiguous: "Multiple Projects match",
  environment_ambiguous: "Ambiguous Environment",
  environment_not_found: "Environment not found",
  environment_context_missing: "Environment context missing",
  repository_ambiguous: "Ambiguous repository",
  repository_missing: "No GitHub remote",
  repository_renamed: "Repository renamed",
  command_unavailable: "Command unavailable",
};

const categoryTitles: Record<CliErrorCategory, string> = {
  invocation: "Invalid invocation",
  "incomplete-export": "Incomplete export",
  conflict: "Conflict",
  crypto: "Cryptographic error",
  authentication: "Authentication error",
  transient: "Service error",
  "local-io": "Local error",
};

const remediationPattern = /;\s*(re-)?run dotrelay [^\n]*$/s;

export const presentationForError = (
  error: unknown,
  options: Readonly<{ readonly debug?: boolean }> = {},
): ErrorPresentation => {
  const diagnostic = diagnosticForError(error, options);
  const lines = diagnostic.detail.split("\n");
  const first = lines[0] ?? "";
  const rest = lines.slice(1);
  const title =
    errorTitles[diagnostic.code] ?? categoryTitles[diagnostic.category];
  let detail = first;
  let fixes = rest;
  if (fixes.length === 0) {
    const match = remediationPattern.exec(detail);
    if (match?.index !== undefined) {
      const command = match[0]
        .replace(/^;\s*/, "")
        .replace(/^run /, "run ")
        .replace(/^re-run /, "Re-run ");
      const verb = command.startsWith("run ")
        ? "Run"
        : command.startsWith("Re-run ")
          ? "Re-run"
          : "Run";
      const target = command
        .replace(/^(run |Re-run )/, "")
        .replace(/\s*to .*/, "")
        .trim();
      detail = capitalize(detail.slice(0, match.index).trimEnd());
      fixes = [`${verb} ${target}`];
    } else {
      detail = capitalize(detail);
    }
  } else {
    detail = capitalize(detail);
  }
  return { title, detail, fixes: fixes.map((fix) => capitalize(fix)) };
};

// A failure that is unmistakably cryptographic even though the caller did not
// wrap it: Node crypto/OpenSSL errors carry an ERR_CRYPTO_* or ERR_OSSL_*
// code, and WebCrypto failures surface as the matching DOMException names.
const cryptoRuntimeErrorNames = new Set([
  "OperationError",
  "DataError",
  "NotSupportedError",
]);

const isCryptoRuntimeError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { readonly code?: unknown }).code;
  if (typeof code === "string" && /^ERR_(CRYPTO|OSSL)_[A-Z0-9_]+$/.test(code))
    return true;
  const name = (error as { readonly name?: unknown }).name;
  return typeof name === "string" && cryptoRuntimeErrorNames.has(name);
};

const problemCodeFor = (error: unknown): string | null => {
  if (error instanceof ContractError) return error.code;
  if (error instanceof ProtocolTransportError) return error.problem.code;
  return null;
};

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

const debugDetailFor = (error: unknown, debug: boolean): string =>
  debug && error instanceof Error
    ? sanitizeCliText(error.message).slice(0, 512) ||
      "The command could not complete."
    : "The command could not complete.";

export const diagnosticForError = (
  error: unknown,
  options: Readonly<{ readonly debug?: boolean }> = {},
): CliDiagnostic => {
  if (error instanceof CliError) {
    const safeDetails = Object.fromEntries(
      Object.entries(error.details).filter(([key, value]) => {
        if (!safeDiagnosticKeys.has(key)) return false;
        if (key === "requestPath" || key === "correlationId")
          return typeof value === "string" && value.length <= 256;
        return (
          safeDiagnosticNumericKeys.has(key) &&
          typeof value === "number" &&
          Number.isInteger(value) &&
          value >= 0 &&
          value <= 1_000_000_000
        );
      }),
    );
    const detail =
      sanitizeCliText(error.message).slice(0, 512) ||
      "The command could not complete.";
    // The category and exit code the command assigned are kept: they tell
    // automation whether to stop, retry, or request approval. Only the code
    // is masked when it is not one the CLI intentionally raises, so a
    // surprise value can never mint a new stable category.
    return {
      ok: false,
      category: error.category,
      code: safeDiagnosticCodes.has(error.code)
        ? error.code
        : "unexpected_failure",
      detail,
      ...safeDetails,
      exitCode: error.exitCode,
    };
  }
  const problemCode = problemCodeFor(error);
  if (problemCode !== null) {
    const category = categoryForProblem(problemCode);
    return {
      ok: false,
      category,
      code: safeDiagnosticCodes.has(problemCode)
        ? problemCode
        : "unexpected_failure",
      detail: detailForProblem(problemCode),
      exitCode: categoryExitCode[category],
    };
  }
  if (isCryptoRuntimeError(error)) {
    return {
      ok: false,
      category: "crypto",
      code: "crypto",
      detail: debugDetailFor(error, options.debug === true),
      exitCode: EXIT_CODES.crypto,
    };
  }
  return {
    ok: false,
    category: "local-io",
    code: "unexpected_failure",
    detail: debugDetailFor(error, options.debug === true),
    exitCode: EXIT_CODES.localIo,
  };
};

export const humanDetailForError = (
  error: unknown,
  options: Readonly<{ readonly debug?: boolean }> = {},
): string => {
  const problemCode = problemCodeFor(error);
  if (problemCode !== null) return detailForProblem(problemCode);
  // A raw crypto runtime failure stays as opaque on human stderr as in the
  // JSON document, so both modes name the same severity and next action;
  // --debug opts both into the sanitized operational message.
  if (isCryptoRuntimeError(error))
    return diagnosticForError(error, options).detail;
  if (error instanceof Error) {
    const detail = sanitizeCliText(error.message).slice(0, 512);
    if (detail.length > 0) return detail;
  }
  return diagnosticForError(error, options).detail;
};
