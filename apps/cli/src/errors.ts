import { ProtocolTransportError } from "@dotrelay/client";
import { ContractError } from "@dotrelay/contracts";
import { HOSTED_ORIGIN } from "./hosted-origin";

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
  "variableNames",
  "retryAfterSeconds",
  "count",
  "variableCount",
  "sharedValueCount",
  "userDefinedValueCount",
  "missingCount",
  "changedCount",
  "conflictCount",
]);
const safeDiagnosticNumericKeys = new Set(safeDiagnosticKeys);

// Every intentional problem code the CLI or the protocol can surface. A code
// outside this set is masked to unexpected_failure so an unforeseen value can
// never leak through as a stable category, while the category and exit code
// the command assigned remain actionable.
const safeDiagnosticCodes = new Set([
  "account_fingerprint_mismatch",
  "account_fingerprint_required",
  "account_key_already_exists",
  "account_key_envelope_conflict",
  "account_key_not_unlocked",
  "account_key_transfer_invalid",
  "account_key_unlock_failed",
  "alpha_admission_required",
  "account_roster_untrusted",
  "account_trust_pins_invalid",
  "archived_resource",
  "artifact_invalid",
  "baseline_invalid",
  "baseline_read_failed",
  "baseline_unverifiable",
  "baseline_write_failed",
  "artifact_read_failed",
  "artifact_too_large",
  "auth_response_invalid",
  "authored_at_out_of_range",
  "authentication",
  "authentication_required",
  "browser_open_failed",
  "capabilities_invalid",
  "capabilities_unavailable",
  "command_unavailable",
  "command_start_failed",
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
  "device_proof_required",
  "recent_sign_in_required",
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
  "history_unverifiable",
  "grant_bootstrap_unavailable",
  "incomplete-export",
  "input_read_failed",
  "invalid_crypto_object",
  "invalid_id",
  "invalid_request",
  "invitation_expired",
  "invocation",
  "local-io",
  "membership_not_active",
  "membership_not_key_provisioned",
  "membership_pending",
  "missing_values",
  "process_control_variable",
  "state_directory_unavailable",
  "state_permissions_invalid",
  "operation_conflict",
  "output_conflict",
  "output_tracked",
  "output_write_failed",
  "owner_transfer_required",
  "payload_too_large",
  "peer_share_failed",
  "pending_invitation_limit",
  "profile_catalog_invalid",
  "profile_catalog_read_failed",
  "profile_catalog_write_failed",
  "profile_mismatch",
  "profile_selection_invalid",
  "project_ambiguous",
  "project_epoch_rollback",
  "project_key_mismatch",
  "project_key_unavailable",
  "publication_invalid",
  "rate_limited",
  "rate_limit_unavailable",
  "recovery_code_malformed",
  "recovery_wrapper_missing",
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
  "transfer_recipient_unknown",
  "transfer_recipient_unverified",
  "transient",
  "trusted_head_conflict",
  "trusted_head_invalid",
  "trusted_head_read_failed",
  "trust_failed",
  "unconfirmed_legacy_lane",
  "unreadable_manifest",
  "unsafe_stdout",
  "unsupported_api_version",
  "unsupported_crypto_runtime",
  "unsupported_crypto_suite",
  "unsupported_media_type",
  "user_mismatch",
  "unexpected_failure",
  "variable_conflict",
]);

// Unicode format characters that reorder or hide text on a terminal: zero
// width and directional marks, bidi embeddings and overrides, and bidi
// isolates. Server-supplied text could use them to disguise what it says.
const isFormatCharacter = (codePoint: number): boolean =>
  (codePoint >= 0x200b && codePoint <= 0x200f) ||
  (codePoint >= 0x202a && codePoint <= 0x202e) ||
  (codePoint >= 0x2066 && codePoint <= 0x2069);

// Removes C0 controls (except tab, line feed and carriage return), DEL, C1
// controls and bidi/format characters, so text received from a server or a
// file cannot carry ANSI/OSC escape sequences or reorder what is printed.
export const sanitizeCliText = (detail: string): string =>
  Array.from(detail)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint === 9 || codePoint === 10 || codePoint === 13) return true;
      if (codePoint < 32 || (codePoint >= 127 && codePoint <= 159))
        return false;
      return !isFormatCharacter(codePoint);
    })
    .join("");

// For a value printed inside a single line (a card row, a menu entry): the
// sanitized text with tabs and line breaks folded to single spaces.
export const sanitizeCliLine = (detail: string): string =>
  sanitizeCliText(detail).replace(/[\t\r\n]+/g, " ");

export const categoryForProblem = (
  code: string,
): "invocation" | "conflict" | "crypto" | "authentication" | "transient" => {
  if (
    code === "authentication_required" ||
    code === "alpha_admission_required" ||
    code === "device_not_active" ||
    code === "device_proof_required" ||
    code === "recent_sign_in_required" ||
    code === "forbidden" ||
    code === "repository_access_denied"
  )
    return "authentication";
  if (
    [
      "membership_not_active",
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
      "authored_at_out_of_range",
      "pending_invitation_limit",
      "owner_transfer_required",
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

// GitHub shows DotRelay only the repositories its GitHub App is installed on.
// The Server Profile publishes the install link when it knows its app.
export const repositoryAccessDeniedDetail = (installUrl?: string): string =>
  [
    "DotRelay could not access this GitHub repository.",
    "1. Check the repository name and that your GitHub account can open it.",
    installUrl
      ? `2. Install the DotRelay GitHub App and choose this repository: ${installUrl}`
      : "2. Install this server's DotRelay GitHub App and choose this repository. Ask the server operator for the install link. Installed already? Add the repository at https://github.com/settings/installations.",
    "3. If an organization owns the repository, an organization owner may need to approve the app, and SSO may need authorizing. Then retry your command.",
  ].join("\n");

// A wait the operator can act on: "30 seconds", "4 minutes", "2 hours".
export const describeWait = (seconds: number): string => {
  const unit = (value: number, name: string): string =>
    `${value} ${name}${value === 1 ? "" : "s"}`;
  if (seconds < 60) return unit(Math.max(1, Math.ceil(seconds)), "second");
  if (seconds < 3600) return unit(Math.ceil(seconds / 60), "minute");
  return unit(Math.ceil(seconds / 3600), "hour");
};

const isHostedOrigin = (origin: string | undefined): boolean => {
  if (origin === undefined) return false;
  try {
    return new URL(origin).origin === new URL(HOSTED_ORIGIN).origin;
  } catch {
    return false;
  }
};

/**
 * The answer for a GitHub account outside a server's alpha list. Only
 * DotRelay's hosted service takes access requests by email; anywhere else,
 * including when the origin is unknown, the server's operator decides.
 */
export const alphaAdmissionDetail = (origin?: string): string =>
  [
    isHostedOrigin(origin)
      ? "DotRelay is in private alpha and this GitHub account isn't on the list yet. Email support@dotrelay.dev to request access."
      : "This DotRelay server is in private alpha and this GitHub account isn't on its list yet. Ask this server's operator for access.",
    "To use another GitHub account, run dotrelay logout, then dotrelay login.",
  ].join("\n");

export const detailForProblem = (
  code: string,
  context: Readonly<{
    readonly retryAfterSeconds?: number;
    /** The Server Profile origin that answered, when the caller knows it. */
    readonly origin?: string;
  }> = {},
): string => {
  if (code === "alpha_admission_required")
    return alphaAdmissionDetail(context.origin);
  if (code === "authentication_required")
    return "login is required for this Server Profile; run dotrelay login";
  if (code === "device_not_active")
    return "this Device is not active; run dotrelay device enroll to re-authorize it";
  if (code === "device_proof_required")
    return "the Server Profile did not accept this Device's proof of its key; run the command again, and run dotrelay login if it keeps failing";
  if (code === "recent_sign_in_required")
    return "this account has no active Device, so this action needs a sign-in from the last ten minutes; run dotrelay login and try again";
  if (code === "membership_not_key_provisioned")
    return [
      "you joined this Team, but its Project keys have not been shared with you yet.",
      'A Team owner or admin has to share them: in the DotRelay web app they open Members and choose "Share project keys" for you, or they run dotrelay team share-keys <your-github-login>.',
      "Then run dotrelay pull.",
    ].join("\n");
  if (code === "membership_not_active")
    // Servers before membership_not_key_provisioned send this code for a
    // Membership waiting for keys too, so both repairs are still named.
    return [
      "your Membership in this Team is not active yet.",
      'If you accepted an invitation, a Team owner or admin still has to share the Project keys with you: in the DotRelay web app they open Members and choose "Share project keys" for you, or they run dotrelay team share-keys <your-github-login>.',
      "If you were removed from the Team, ask an owner or admin to invite you again.",
      "Then run dotrelay pull.",
    ].join("\n");
  if (code === "forbidden") return "the Server Profile denied the request";
  if (code === "resource_not_found")
    return "the requested resource was not found";
  if (code === "invalid_request")
    return "the Server Profile rejected the request";
  if (code === "payload_too_large") return "the request was too large";
  if (code === "genesis_exists")
    return "this Environment already has a genesis Revision";
  if (code === "repository_access_denied")
    return repositoryAccessDeniedDetail();
  if (code === "github_rate_limited")
    return "GitHub rate-limited the Server Profile's repository lookup; wait for the stated retry window and retry";
  if (code === "github_unavailable")
    return "GitHub could not be reached through the Server Profile; established sync is unaffected, retry once GitHub is available";
  if (code === "rate_limited")
    return context.retryAfterSeconds !== undefined &&
      Number.isFinite(context.retryAfterSeconds) &&
      context.retryAfterSeconds >= 0
      ? `the Server Profile rate-limited the request; wait ${describeWait(context.retryAfterSeconds)} and retry`
      : "the Server Profile rate-limited the request; wait and retry";
  if (code === "authored_at_out_of_range")
    return [
      "the Server Profile rejected the Revision's timestamp: it is earlier than this Device's activation, your Membership, or the Revision before it, or more than 10 minutes in the future.",
      "Check that this machine's system clock and time zone are correct (enable automatic time sync), then run the command again.",
    ].join("\n");
  if (code === "pending_invitation_limit")
    return "this Team has reached its limit of pending invitations; revoke invitations that are no longer needed in the DotRelay web app, or wait for them to be accepted, declined, or expire";
  if (code === "rate_limit_unavailable")
    return "the Server Profile's rate limiter is unavailable; retry later";
  if (code === "owner_transfer_required")
    return "you are this Team's last active owner; make another active Member an owner in the DotRelay web app, or delete the Team, first";
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
  alpha_admission_required: "Private alpha",
  device_not_active: "Device not active",
  device_proof_required: "Device not proven",
  recent_sign_in_required: "Recent sign-in required",
  membership_not_active: "Membership not active",
  membership_not_key_provisioned: "Waiting for Project keys",
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
  pending_invitation_limit: "Too many pending invitations",
  owner_transfer_required: "Ownership transfer required",
  authored_at_out_of_range: "Clock out of range",
  rollback_target_unavailable: "Rollback target unavailable",
  rollback_variable_absent: "Rollback target missing Variables",
  unreadable_manifest: "Unreadable manifest",
  history_unverifiable: "Environment history does not verify",
  unconfirmed_legacy_lane: "Legacy Value from an unconfirmed teammate",
  account_key_not_unlocked: "Device not unlocked",
  account_key_unlock_failed: "Could not unlock account",
  account_key_transfer_invalid: "Account key transfer invalid",
  recovery_code_malformed: "Recovery code invalid",
  recovery_wrapper_missing: "No Recovery Code wrapper",
  project_ambiguous: "Multiple Projects match",
  project_key_unavailable: "Project key unavailable",
  project_key_mismatch: "Project key does not match",
  project_epoch_rollback: "Project epoch went backwards",
  account_roster_untrusted: "Account Device list untrusted",
  account_fingerprint_mismatch: "Account fingerprint does not match",
  account_fingerprint_required: "Account fingerprint required",
  transfer_recipient_unverified: "Device not in your signed list",
  command_start_failed: "Could not start command",
  membership_pending: "Waiting for Project keys",
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

// The sync verifier's refusal: the Server Profile served Revisions this
// Device cannot verify. Its messages are fixed strings, never server text.
const isHistoryVerificationError = (error: unknown): error is Error =>
  error instanceof Error && error.name === "ProtocolVerificationError";

const historyVerificationDetail = (error: Error): string =>
  `the Server Profile returned Environment history that does not verify (${sanitizeCliLine(error.message).slice(0, 200)}). Nothing was written. Do not trust this Server Profile until you have checked it`;

const isCryptoRuntimeError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { readonly code?: unknown }).code;
  if (typeof code === "string" && /^ERR_(CRYPTO|OSSL)_[A-Z0-9_]+$/.test(code))
    return true;
  const name = (error as { readonly name?: unknown }).name;
  return typeof name === "string" && cryptoRuntimeErrorNames.has(name);
};

const retryContextFor = (
  error: unknown,
): Readonly<{ readonly retryAfterSeconds?: number }> =>
  error instanceof ProtocolTransportError &&
  error.problem.retryAfterSeconds !== undefined
    ? { retryAfterSeconds: error.problem.retryAfterSeconds }
    : {};

const retryAfterDiagnostic = (
  error: unknown,
): Readonly<{ readonly retryAfterSeconds?: number }> => {
  const seconds = retryContextFor(error).retryAfterSeconds;
  return seconds !== undefined &&
    Number.isInteger(seconds) &&
    seconds >= 0 &&
    seconds <= 1_000_000_000
    ? { retryAfterSeconds: seconds }
    : {};
};

export const problemCodeFor = (error: unknown): string | null => {
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
        if (
          key === "requestPath" ||
          key === "correlationId" ||
          key === "variableNames"
        )
          return typeof value === "string" && value.length <= 512;
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
      detail: detailForProblem(problemCode, retryContextFor(error)),
      ...retryAfterDiagnostic(error),
      exitCode: categoryExitCode[category],
    };
  }
  if (isHistoryVerificationError(error))
    return {
      ok: false,
      category: "crypto",
      code: "history_unverifiable",
      detail: historyVerificationDetail(error),
      exitCode: EXIT_CODES.crypto,
    };
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
  if (problemCode !== null)
    return detailForProblem(problemCode, retryContextFor(error));
  if (isHistoryVerificationError(error))
    return historyVerificationDetail(error);
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
