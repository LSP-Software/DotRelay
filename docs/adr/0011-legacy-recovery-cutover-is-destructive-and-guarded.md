# The legacy-recovery cutover is destructive and pre-production

Status: accepted

`20260922000000_account_key_models` — the migration that retired the pre-ADR-0009
Recovery Kit in favor of Account Key Wrappers — is **not** an additive change.
This ADR records what it destroys, the human decision to run it on every
deployment, and the guard that protects a future durable deployment.

## What the migration does

- **Drops tables** (any rows they hold are deleted):
  - `recovery_attempts`
  - `recovery_challenge_objects`
  - `recovery_envelopes`
  - `recovery_grant_objects`
- **Re-types enums by removing members.** `AuditEntityKind` loses
  `RECOVERY_ENVELOPE`; `AuditEventKind` loses `RECOVERY_COMPLETED`;
  `OperationKind` loses `RECOVERY`; `GrantKind` loses
  `RECOVERY_PROJECT_KEY` and `RECOVERY_USER_VALUE_KEY`. The re-type is a
  `USING ("col"::text::"new_enum")` cast, so it **fails closed** if any row
  still holds a removed member.
- **Drops `users.recoveryGeneration`** (the recovery-generation counter is
  obsolete; wrapper lifecycle now lives on the wrapper objects).
- Adds the `account_key_wrapper_objects` / `account_key_envelope_objects` /
  `account_key_transfer_objects` tables and their `WrapperType` /
  `KeyEnvelopeType` / `TransferStatus` enums.

A database that has in-flight legacy recovery activity — a recovery envelope,
a `RECOVERY` operation, a `RECOVERY_COMPLETED` audit event, or a user with
`recoveryGeneration > 1` — will either have that data silently destroyed (the
dropped tables) or have the migration fail on the enum re-type.

## Decision

DotRelay is **pre-production**: no durable/production deployment is reachable
by real users, so the data behind the legacy `recovery_*` tables is disposable.
A human (2026-09-23) confirmed the deployment matrix and that no durable
deployment populated those tables with in-flight user recovery data. The drop
is therefore safe to run on every deployment, and no pre-deploy data export is
required today.

Even so, the campaign (#231, Phase 4) requires a loud guard and documentation
so that if a durable deployment later reaches the cutover with live recovery
data, the failure is caught **before** `prisma migrate deploy` rather than
discovered after rows are gone.

## Consequences

- **`scripts/guard-legacy-recovery-cutover.ts`** is an operator pre-deploy
  gate. Point it at a target database that has not yet cut over; it reports
  any legacy `recovery_*` rows and any legacy enum values the new enums cannot
  represent, and **refuses (exit 1)** unless the operator passes
  `--acknowledge-legacy-recovery-data`. A database that has already cut over
  (or holds no legacy data) passes silently.
- The runbook in `docs/wiki/persistence.md` documents when and how to run the
  guard before a durable `prisma migrate deploy`.
- `scripts/check-migrations.ts` gains a **realistic pre-change fixture**: it
  builds a pre-cutover database with legacy recovery data and proves (a) the
  cutover applies cleanly to a disposable state and lands drift-free with the
  legacy tables gone, and (b) the enum re-type fails loudly on a database that
  still carries legacy recovery values.

## Note on the migration itself

The migration SQL is already committed and applied on `main`; this ADR does not
modify it. The guard and the tests above are additive and live outside the
migration so that `db:migrate-check`'s checksum/drift verification stays valid
for every deployment that has already applied the migration.
