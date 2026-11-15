# Privacy-preserving observability

DotRelay has three separate operational records. Application Diagnostic Events are non-durable
structured records for service behavior. Audit Facts are durable, append-only facts for successful
security and domain changes. Security Request Logs are short-retention request metadata for
security investigation. A record must never be used as a substitute for one of the other two.

## Application Diagnostic Events

The fixed schema is version `1`. Its Diagnostic Field Allowlist is:

- `eventName`, one of the bounded operational tokens `api.request.completed`,
  `api.security_request_log.write_failed`, `api.security_request_log.expiry_failed`,
  `api.staging.expiry_failed`, `api.retention.expiry_failed`,
  `api.retention.cleanup_completed`, `api.readiness.checked`, `api.rate_limit.user_refused`,
  `api.rate_limit.github_refused`, `api.rate_limit.creation_refused`,
  `api.rate_limit.auth_refused`, `api.rate_limit.unavailable`, `api.email.sent`,
  `api.email.failed`, or `api.email.skipped`;
- `correlationId`, a fresh opaque UUID used only to link one request or bounded execution;
- `durationMs`, a non-negative bounded integer;
- `outcome`, a bounded operational token;
- `problemCode`, a bounded stable problem code;
- `retryAfterSeconds`, a bounded non-negative integer;
- `emailKind`, one of `invitation`, `keys_shared` or `invitation_accepted`; and
- `emailReason`, one of `timeout`, `network`, `rejected`, `rate_limited`, `server_error`,
  `lookup_failed`, `queue_full`, `no_recipient` or `no_address`.

Unknown fields, nested context, messages, stack traces, headers, query values, bodies, credentials,
keys, ciphertext, plaintext, domain identifiers, and IP addresses are rejected by event creation
or removed by the fail-closed redactor. Correlation IDs are support references, not User, Device,
Team, Project, Environment, Variable, Revision, or GitHub Repository identifiers. API responses
also return the Correlation ID in `X-Correlation-ID`.

Diagnostics are sampled and retained for at most 14 days. The browser and CLI keep diagnostics
local; they do not upload them automatically. Optional private traces are local-only and retained
for at most seven days. Crash reports are sanitized and can be created only by an explicit caller;
they contain a Correlation ID and stable problem code, never the original Error object, message, or
stack.

Metrics may use only `eventName`, `outcome`, `problemCode`, `emailKind` and `emailReason`
dimensions, plus the HTTP status class (`1xx` to `5xx`) on the request counter. They must not include domain identifiers, IPs,
request values, or cryptographic material. Diagnostic and security-log loss is non-blocking and
cannot change domain behavior.

## Metrics

The API keeps bounded counters in process memory and sends them nowhere. They are served only
when an operator enables the private metrics listener (see
[operations](operations.md#metrics-and-alerting)). Every sanitized diagnostic event is counted,
including successful requests that sampling drops from the log. The families are:

- `dotrelay_events_total{event_name, outcome, problem_code}`, one series per event name, outcome
  and problem code;
- `dotrelay_http_requests_total{status_class}` and the unlabelled histogram
  `dotrelay_http_request_duration_seconds`, for API requests other than `/health` and `/ready`;
  and
- `dotrelay_ready`, the readiness result computed at each scrape.

Label values come from fixed allowlists: the event names above, `success`/`failure`, the stable
problem codes, and the five status classes. Absent values are `none`; anything else is `other`,
and each family holds at most 512 series. The status class is allowed because it is derived from
the response status alone and has five values; route templates are not used.

Events added for alerting:

- `api.retention.cleanup_completed` (`success` or `failure`, with `durationMs`) closes each
  10-minute retention run;
- `api.readiness.checked` records each `/ready` request and metrics scrape; only failures are
  logged;
- `api.rate_limit.user_refused`, `github_refused`, `creation_refused` and `auth_refused` name the
  limiter that answered `rate_limited` (the per-User general and protocol budgets count as
  `user`; `auth` is Better Auth's per-IP sign-in limiter); and
- `api.rate_limit.unavailable` marks a `rate_limit_unavailable` answer.

## Audit Facts and Security Request Logs

Audit Facts are written in the same transaction as the successful domain or security change. An
Audit Fact write failure aborts the associated commit. Audit Facts are unsampled, durable, and
append-only; they contain only approved opaque actors, affected entity references, lifecycle
change, receipt time, and immutable outcome references. They never contain protected content.

Security Request Logs are separate, allowlisted records containing only the server-derived IP
(provided to the API observability adapter by the HTTP server or trusted proxy adapter),
canonical endpoint template, HTTP status, transfer size, request time, and expiry. They do not
contain User-Agent data, request bodies, query values, credentials, plaintext, ciphertext, or free-
form metadata. Anonymous liveness and discovery probes (`/health` and `/api/v1/capabilities`) are
not recorded, so a flood of them never becomes database writes. Other requests without a signed-in
session (sign-in, device authorization, a rejected session) are recorded only within a budget: 30
rows per client address and 600 rows overall per minute, per API process. Requests from signed-in
sessions are always recorded; the per-User rate limit bounds them. Hosted deployments retain them for
30 days by default and operators must restrict access more tightly than ordinary diagnostics. Cleanup may remove expired Security Request Logs;
Audit Facts and accepted protocol history are not physically deleted.

## Operations and release gate

The Bun adapter obtains the peer address from the server connection (`requestIP`). With
`SERVER_PROFILE_TRUST_PROXY=true` it resolves the client the same way Better Auth does: it walks
`X-Forwarded-For` (ending in the socket peer) from the right, skips addresses in
`SERVER_PROFILE_TRUSTED_PROXIES`, and records the first untrusted hop. A forwarded header from an
untrusted peer is ignored, and the leftmost, client-supplied entry is never trusted on its own.
The API process runs the retention cleanup every 10 minutes: it expires abandoned staging
operations and staged rows, then expired Security Request Logs, then short-lived auth, enrollment,
and invitation rows (see [persistence](persistence.md#migration-and-retention-policy)), each in
bounded batches of short transactions with a per-run time budget. Failures emit
`api.staging.expiry_failed`, `api.security_request_log.expiry_failed`, or
`api.retention.expiry_failed`, and the run ends with `api.retention.cleanup_completed`;
operators must alert on the failures. Both deployment modes use
the same 30-day maximum and allowlist.

Diagnostic access is limited to the operations role. Security Request Logs are limited to the
security-response role and are not available to ordinary support users. Break-glass access requires
an incident reference, an approving security owner, least-privilege temporary access, and a review
of the access record after the incident. The database additionally applies forced row-level security:
Security Request Log reads require the explicit `dotrelay.security_request_log_access` transaction
setting with value `security-response` and membership in the dedicated PostgreSQL
`dotrelay_security_response` role; the application has no ordinary support read path. The release
checklist must record security-review approval of this privacy boundary and verify hosted/self-hosted
policy parity before production release.
