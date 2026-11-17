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
  "profile_not_selected",
  "profile_selection_invalid",
  "project_ambiguous",
  "project_epoch_rollback",
  "project_key_mismatch",
  "project_key_unavailable",
  "project_not_linked",
  "publication_invalid",
  "publication_uncertain",
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
    "1. Check the repository name and that your GitHub account can open it.",
    installUrl
      ? `2. Install the DotRelay GitHub App and choose this repository: ${installUrl}`
      : "2. Install this server's DotRelay GitHub App and choose this repository. Ask the server operator for the install link. Installed already? Add the repository at https://github.com/settings/installations.",
    "3. If an organization owns the repository, an organization owner may need to approve the app, and you may need to authorize SSO. Then retry your command.",
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
    return "You're not signed in to this server. Run dotrelay login.";
  if (code === "device_not_active")
    return "This device isn't active anymore, so it has to be enrolled again. Run dotrelay device enroll.";
  if (code === "device_proof_required")
    return "The server didn't accept this device's proof of its key. Run the command again. If it keeps failing, sign in again with dotrelay login.";
  if (code === "recent_sign_in_required")
    return "This account has no active device, so this needs a sign-in from the last ten minutes. Sign in with dotrelay login, then try again.";
  if (code === "membership_not_key_provisioned")
    return [
      "You joined this team, but nobody has shared its project keys with you yet.",
      'A team owner or admin has to share them. In the DotRelay web app they open Members and choose "Share project keys" for you, or they run dotrelay team share-keys <your-github-login>.',
      "Then run dotrelay pull.",
    ].join("\n");
  if (code === "membership_not_active")
    // Servers before membership_not_key_provisioned send this code for a
    // Membership waiting for keys too, so both repairs are still named.
    return [
      "Your membership in this team isn't active yet.",
      'If you accepted an invitation, a team owner or admin still has to share the project keys with you. In the DotRelay web app they open Members and choose "Share project keys" for you, or they run dotrelay team share-keys <your-github-login>.',
      "If you were removed from the team, ask an owner or admin to invite you again.",
      "Then run dotrelay pull.",
    ].join("\n");
  if (code === "forbidden")
    return "The server says your account isn't allowed to do this.";
  if (code === "resource_not_found")
    return "The server couldn't find what this command asked for. It may have been removed, or you may no longer have access to it.";
  if (code === "invalid_request")
    return "The server rejected the request as invalid.";
  if (code === "payload_too_large")
    return "The request was too large for the server.";
  if (code === "genesis_exists")
    return "This environment has already been published.";
  if (code === "repository_access_denied")
    return repositoryAccessDeniedDetail();
  if (code === "github_rate_limited")
    return "GitHub is rate-limiting this server's repository lookups. Wait a while, then try again.";
  if (code === "github_unavailable")
    return "The server couldn't reach GitHub. Projects that are already linked still sync. Try again once GitHub is back.";
  if (code === "rate_limited")
    return context.retryAfterSeconds !== undefined &&
      Number.isFinite(context.retryAfterSeconds) &&
      context.retryAfterSeconds >= 0
      ? `The server is rate-limiting requests. Wait ${describeWait(context.retryAfterSeconds)} and retry.`
      : "The server is rate-limiting requests. Wait a moment and retry.";
  if (code === "authored_at_out_of_range")
    return [
      "The server rejected the revision's timestamp. It's earlier than this device's activation, your membership, or the previous revision, or more than 10 minutes in the future.",
      "Check that this machine's system clock and time zone are right (turn on automatic time sync), then run the command again.",
    ].join("\n");
  if (code === "pending_invitation_limit")
    return "This team has too many pending invitations. In the DotRelay web app, revoke invitations that are no longer needed, or wait for some to be accepted, declined or expire.";
  if (code === "rate_limit_unavailable")
    return "The server's rate limiter isn't available, so it can't take requests right now. Try again later.";
  if (code === "owner_transfer_required")
    return "You're this team's last active owner. First make another active member an owner in the DotRelay web app, or delete the team.";
  if (categoryForProblem(code) === "conflict")
    return "This change conflicts with what's on the server now. Try the command again.";
  if (categoryForProblem(code) === "crypto")
    return "The server rejected the encrypted data in this request. Check that your DotRelay CLI is up to date.";
  return "The server couldn't complete the request. Try again in a moment.";
};

// A sentence that opens with a command ("dotrelay setup needs ...") keeps
// the command as typed.
export const capitalize = (text: string): string =>
  text.length === 0 || /^dotrelay\s/.test(text)
    ? text
    : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

export type ErrorPresentation = Readonly<{
  readonly title: string;
  readonly detail: string;
  readonly fixes: readonly string[];
}>;

const errorTitles: Record<string, string> = {
  authentication_required: "You're signed out",
  alpha_admission_required: "Not on the alpha list yet",
  device_not_active: "This device isn't active",
  device_proof_required: "The server didn't accept this device's key",
  recent_sign_in_required: "Sign in again to do this",
  membership_not_active: "Your team membership isn't active",
  membership_not_key_provisioned: "Waiting for project keys",
  device_bundle_missing: "This machine isn't enrolled",
  device_enrollment_failed: "Couldn't enroll this device",
  device_enrollment_unavailable: "Can't enroll devices right now",
  device_authorization_denied: "Sign-in was denied",
  device_authorization_expired: "The sign-in code expired",
  device_authorization_timeout: "Sign-in timed out",
  device_authorization_failed: "Couldn't sign in",
  forbidden: "Not allowed",
  profile_mismatch: "This is for a different server",
  user_mismatch: "This is for a different user",
  repository_access_denied: "DotRelay can't see this repository",
  github_rate_limited: "GitHub is rate-limiting requests",
  github_unavailable: "Couldn't reach GitHub",
  service_unavailable: "Couldn't reach the server",
  request_failed: "The server couldn't finish the request",
  rate_limited: "Too many requests",
  rate_limit_unavailable: "The server can't take requests right now",
  response_invalid: "The server sent a response DotRelay can't read",
  response_too_large: "The server's response was too large",
  genesis_exists: "Already published",
  output_conflict: "The file doesn't match the environment",
  output_tracked: "Git tracks this file",
  output_write_failed: "Couldn't write the file",
  input_read_failed: "Couldn't read the file",
  deletion_requires_approval: "Removing variables needs your approval",
  unsafe_stdout: "This would print values to your terminal",
  staging_expired: "The request expired",
  staged_object_missing: "The request is gone",
  invitation_expired: "The invitation expired",
  pending_invitation_limit: "Too many pending invitations",
  owner_transfer_required: "Make someone else an owner first",
  authored_at_out_of_range: "Check this machine's clock",
  rollback_target_unavailable: "Can't roll back to that revision",
  rollback_variable_absent: "That revision doesn't have these variables",
  unreadable_manifest: "This device can't read the environment",
  history_unverifiable: "The environment's history doesn't verify",
  unconfirmed_legacy_lane: "A value from a teammate you haven't confirmed",
  account_key_not_unlocked: "This device can't read values yet",
  account_key_unlock_failed: "Couldn't unlock your account key",
  account_key_transfer_invalid: "The transfer didn't work",
  recovery_code_malformed: "That recovery code isn't valid",
  recovery_wrapper_missing: "No recovery code is set up",
  project_ambiguous: "More than one project matches",
  project_key_unavailable: "This device doesn't have the project key",
  project_key_mismatch: "The project key doesn't match",
  project_epoch_rollback: "The server sent an older project key",
  account_roster_untrusted: "Your device list doesn't verify",
  account_fingerprint_mismatch: "The account fingerprint doesn't match",
  account_fingerprint_required: "Confirm the account fingerprint",
  transfer_recipient_unverified: "That device isn't in your signed device list",
  command_start_failed: "Couldn't start the command",
  membership_pending: "Waiting for project keys",
  environment_ambiguous: "More than one environment matches",
  environment_not_found: "No such environment",
  environment_context_missing: "No environment selected",
  repository_ambiguous: "More than one repository",
  repository_missing: "No GitHub remote",
  repository_renamed: "The remote points at a different repository",
  command_unavailable: "This command isn't available",
};

const categoryTitles: Record<CliErrorCategory, string> = {
  invocation: "Check the command",
  "incomplete-export": "Some values are missing",
  conflict: "Couldn't apply the change",
  crypto: "Couldn't verify encrypted data",
  authentication: "You don't have access",
  transient: "Couldn't reach the server",
  "local-io": "Something went wrong on this machine",
};

/** The generic headline for a category, used when a code has none. */
export const categoryTitleFor = (category: CliErrorCategory): string =>
  categoryTitles[category];

// The older form: "...; run dotrelay x to do y".
const legacyRemediationPattern = /;\s*(re-)?run (dotrelay [^\n]*)$/s;

// The sentence form: "... Run dotrelay x." as the last sentence. A command
// can contain dots (an origin, a file name), so a sentence ends only at a
// dot followed by a space or the end of the line.
const sentenceRemediationPattern =
  /(^|[.?]\s+)(Run|Re-run) (dotrelay (?:[^\n.]|\.(?=\S))*)\.?\s*$/;

// "dotrelay x to do y" names the command and why; the fix keeps the command.
const commandOnly = (command: string): string =>
  command.replace(/\s+to\s.*$/s, "").trim();

// A sentence that offers two routes or a follow-up step ("x, then y",
// "x or y") stays in the detail; only a single command becomes a fix.
const isSingleCommand = (command: string): boolean =>
  !/[,;]|\sthen\s/.test(command) && !/\sor\s(?![^()]*\))/.test(command);

// Splits a trailing "Run dotrelay x." (or the older "; run dotrelay x")
// off the first line, so the card can show it as the fix and the same
// command isn't printed twice next to the `next` line.
const splitRemediation = (
  line: string,
): Readonly<{ detail: string; fix?: string }> => {
  const legacy = legacyRemediationPattern.exec(line);
  if (legacy?.[2] !== undefined)
    return {
      detail: line.slice(0, legacy.index).trimEnd(),
      fix: `${legacy[1] ? "Re-run" : "Run"} ${commandOnly(legacy[2])}`,
    };
  const sentence = sentenceRemediationPattern.exec(line);
  if (sentence?.[3] !== undefined) {
    const command = commandOnly(sentence[3]);
    if (isSingleCommand(command)) {
      const end = sentence.index + (sentence[1]?.length ?? 0);
      const detail = line.slice(0, end).trimEnd();
      return {
        detail: detail.length > 0 ? detail : line,
        ...(detail.length > 0 ? { fix: `${sentence[2]} ${command}` } : {}),
      };
    }
  }
  return { detail: line };
};

export const presentationForError = (
  error: unknown,
  options: Readonly<{ readonly debug?: boolean }> = {},
): ErrorPresentation => {
  const diagnostic = diagnosticForError(error, options);
  const lines = diagnostic.detail.split("\n");
  const title =
    errorTitles[diagnostic.code] ?? categoryTitles[diagnostic.category];
  const { detail, fix } = splitRemediation(lines[0] ?? "");
  const fixes = [...(fix ? [fix] : []), ...lines.slice(1)];
  return {
    title,
    detail: capitalize(detail),
    fixes: fixes.map((line) => capitalize(line)),
  };
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
  `The server sent environment history that doesn't verify (${sanitizeCliLine(error.message).slice(0, 200)}). Nothing was written. Don't trust this server until you've checked it.`;

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
