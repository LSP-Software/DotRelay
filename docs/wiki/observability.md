# Privacy-preserving observability

DotRelay has three separate operational records. Application Diagnostic Events are non-durable
structured records for service behavior. Audit Facts are durable, append-only facts for successful
security and domain changes. Security Request Logs are short-retention request metadata for
security investigation. A record must never be used as a substitute for one of the other two.

## Application Diagnostic Events

The fixed schema is version `1`. Its Diagnostic Field Allowlist is:

- `eventName`, a bounded operational token;
- `correlationId`, a fresh opaque UUID used only to link one request or bounded execution;
- `durationMs`, a non-negative bounded integer;
- `outcome`, a bounded operational token;
- `problemCode`, a bounded stable problem code; and
- `retryAfterSeconds`, a bounded non-negative integer.

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

Metrics may use only `eventName`, `outcome`, and `problemCode` dimensions. They must not include
domain identifiers, IPs, request values, or cryptographic material. Diagnostic and security-log
loss is non-blocking and cannot change domain behavior.

## Audit Facts and Security Request Logs

Audit Facts are written in the same transaction as the successful domain or security change. An
Audit Fact write failure aborts the associated commit. Audit Facts are unsampled, durable, and
append-only; they contain only approved opaque actors, affected entity references, lifecycle
change, receipt time, and immutable outcome references. They never contain protected content.

Security Request Logs are separate, allowlisted records containing only the server-derived IP
(provided to the API observability adapter by the HTTP server or trusted proxy adapter),
canonical endpoint template, HTTP status, transfer size, request time, and expiry. They do not
contain User-Agent data, request bodies, query values, credentials, plaintext, ciphertext, or free-
form metadata. Hosted deployments retain them for 30 days by default and operators must restrict
access more tightly than ordinary diagnostics. Cleanup may remove expired Security Request Logs;
Audit Facts and accepted protocol history are not physically deleted.

## Operations and release gate

The Bun adapter obtains the peer address from the server connection (`requestIP`). A deployment
behind a proxy may provide an address only through an adapter that validates its trusted-proxy
chain; the generic Hono request object never treats an arbitrary forwarded header as authoritative.
The hosted cleanup job invokes the Security Request Log expiry operation at least hourly. A
self-hosted operator must schedule the same operation and alert on failures; both deployment modes
use the same 30-day maximum and allowlist.

Diagnostic access is limited to the operations role. Security Request Logs are limited to the
security-response role and are not available to ordinary support users. Break-glass access requires
an incident reference, an approving security owner, least-privilege temporary access, and a review
of the access record after the incident. The database additionally applies forced row-level security:
Security Request Log reads require the explicit `dotrelay.security_request_log_access` transaction
setting with value `security-response` and membership in the dedicated PostgreSQL
`dotrelay_security_response` role; the application has no ordinary support read path. The release
checklist must record security-review approval of this privacy boundary and verify hosted/self-hosted
policy parity before production release.
