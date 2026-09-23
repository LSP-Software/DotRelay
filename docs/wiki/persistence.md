# PostgreSQL persistence

`packages/database/prisma/schema.prisma` and the committed SQL migrations define the DotRelay persistence
boundary. PostgreSQL is the source of truth for identity lifecycle, authorization, epochs,
Environment heads, idempotency, immutable protocol history, and audit facts. Better Auth records
remain library-owned and are linked to a DotRelay `User` only through the server-local auth
subject; Better Auth identifiers are never domain foreign keys or protocol identities.

## Projection rules

The current delivery targets the closed `dotrelay-e2ee-v3-classical-webcrypto` suite. A
`ProtocolObject` stores the exact canonical bytes, suite, format, object kind, and SHA-384 digest.
Server-visible object kinds have typed one-to-one projection rows for the fields needed by
authorization, synchronization, lifecycle, and audit checks. Manifest descriptors, ciphertext
lanes, Revisions, and ordered lane commitments are relational projections of the same immutable
object set.

All encrypted bytes and staged objects use PostgreSQL `bytea` (including TOAST-backed values). The
service does not use an object store, dual-write path, generic JSON metadata, or plaintext
Environment/Variable columns. Length checks cover the v3 raw public keys and SHA-384 digests,
protocol/staging ceilings, grant and recovery bounds, and ciphertext projections. Lane scope keeps
User-defined Values tied to their owner and Shared Values tied to their immutable original
provider; administrators do not gain another User's User-defined Value access.

## Transaction boundaries

Repository methods use short ordinary PostgreSQL transactions with bounded wait and execution
timeouts. A committing method locks the aggregate it is changing, re-reads mutable authorization
facts (Device, Membership, lifecycle, epoch, and current head), validates the expected compare-
and-swap state, and commits its immutable objects, projection rows, idempotency outcome, audit
fact, and head update together. The repository never performs network calls while a database lock
is held.

The public repository seams cover atomic Team/owner creation, Environment genesis, ordinary
publication and Rollback, Membership activation, Device enrollment, Recovery envelope replacement
and attempt recording, Project epoch rotation, staging and expiry, archive/restore, idempotency,
and append-only audit facts. Staged objects are private to their operation and Device, expire after
the configured operation lifetime (24 hours by default), and become visible only through an
explicit finalization.

Signed commands and administrative mutations carry a SHA-384 idempotency digest. A byte-identical
retry returns the committed outcome; reusing an operation id or actor/digest pair with different
bytes is a conflict. Stale heads and epochs are returned as reconciliation failures rather than
being rewritten by the service.

## Migration and retention policy

Migrations are forward-only and must be applied to a fresh database and an upgraded database in
CI. `db push` is not a deployment path. Prisma describes the typed client model; SQL migrations
add exact byte lengths, lifecycle and epoch checks, partial uniqueness, deferred last-owner and
current-head constraints, foreign keys, and append-only triggers that Prisma cannot express.

Durable Users, Devices, Memberships, Projects, Environments, protocol objects, Revisions, grants,
commitments, and Audit Facts are not physically deleted. Archival, Membership removal, and Device
revocation are logical lifecycle changes. Cleanup is limited to expired sessions and device codes,
uncommitted expired staging rows, and expired Security Request Logs. Security Request Logs contain
only the approved IP, endpoint template, status, transfer size, and retention timestamps; they do
not contain request bodies, ciphertext, plaintext, credentials, User-Agent data, or free-form
metadata.

### Destructive cutover: legacy recovery data

The committed migration `20260922000000_account_key_models` retires the pre-ADR-0009 Recovery Kit
and is deliberately destructive: it drops the `recovery_envelopes`, `recovery_attempts`,
`recovery_challenge_objects`, and `recovery_grant_objects` tables (deleting any rows they hold)
and re-types `OperationKind`, `AuditEventKind`, `AuditEntityKind`, and `GrantKind` by removing
their `RECOVERY*` members, so a database that still carries those enum values fails the migration
instead of silently discarding the rows. It also drops `users.recoveryGeneration`.

The campaign decision (LSP-Software/DotRelay#233, 2026-09-23) records that DotRelay is
pre-production and the legacy recovery rows on existing deployments are disposable, so the
cutover ships without a data-export prerequisite; the reasoning is in
`docs/adr/0011-legacy-recovery-cutover-is-destructive-and-guarded.md`.

Before running `prisma migrate deploy` against a durable deployment, operators must run the
pre-deploy guard. It reports the dropped tables, the legacy enum rows, and the used recovery
generations it found, and refuses (exit 1) until the operator either exports the data or passes
`--acknowledge-legacy-recovery-data` to record that the data is disposable:

```sh
bun run db:cutover-guard
bun run db:cutover-guard --database <DATABASE_URL>
bun run db:cutover-guard --acknowledge-legacy-recovery-data
```

A database that has already cut over, or that never held legacy recovery data, passes silently.
The guard is an operator tool, not a CI gate: the release `verify` job has no PostgreSQL service.
The CI regression lives in `scripts/check-migrations.ts`, which builds a realistic pre-cutover
database from the committed baseline migrations, seeds legacy recovery state, and asserts that the
guard is loud, that a disposable database cuts over cleanly and lands drift-free, and that a
database with surviving `RECOVERY*` enum rows fails the deploy loudly.

## Local PostgreSQL

Start the repository services with `docker compose up -d postgres valkey`, then apply the committed
migrations through Prisma and run the integration gates:

```sh
bun x prisma migrate deploy --config packages/database/prisma.config.ts
bun run db:migrate-check
bun run test:integration
```

`test:integration` creates a disposable database, deploys the committed migrations, runs the
PostgreSQL repository suite, and drops the database. The suite exercises concurrent idempotency,
atomic administration and publication, Revision Rollback, lifecycle restore, staging and Security
Request Log expiry, last-owner enforcement, and append-only protocol and Audit Fact rows.
`db:migrate-check` separately verifies fresh deployment, an upgrade with representative base-state
rows, migration-history parity, and deliberate schema-drift detection.

Stop local services with `docker compose down`. Production and self-hosted deployments use the
same forward-only migration history and never use `db push`.
