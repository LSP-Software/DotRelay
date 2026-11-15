# Membership periods survive re-invitation

Status: accepted

Clients judge every Revision's signature against the author's Membership window at the signed
authored-at instant (field 34). The service shipped that window as one pair,
`memberSinceMs`/`memberUntilMs`, read from the single `memberships` row for the User and Team.
Accepting a new invitation for a removed Member revived that row and cleared `activatedAt` and
`removedAt`. The User's earlier Revisions then fell outside every window, and every client refused
to verify that history.

## Decision

The `memberships` row stays the one row per (Team, User). The `(teamId, userId)` unique
constraint, every authorization query, and every route that looks a Membership up by Team and
User are unchanged. The row describes only the **current** period.

Before acceptance revives a removed row, the service copies its finished period into a new
append-only table, `membership_periods` (`membershipId`, `activatedAt`, `removedAt`, unique per
`(membershipId, activatedAt)`). A Membership removed while still `PENDING_KEY_GRANT` never held
keys in that period and archives nothing.

`GET /api/v1/workspace/boundary` keeps `memberSinceMs`/`memberUntilMs` on every
`signingTrustDevices` entry as the current period and adds `membershipPeriods`: every period,
archived and current, oldest first, as `{ sinceMs, untilMs }` (`untilMs` is `null` while active).
`@dotrelay/client` admits a Revision when the Device window admits it and **any** listed period
does. A client that does not pass `membershipPeriods` keeps the old single-window check, so
current Revisions verify as before and only history from earlier periods needs the new field.

### Backfill

The migration rebuilds periods already lost to a revival from append-only Audit Facts: each
`MEMBERSHIP_ACCEPTED` fact with prior lifecycle `REMOVED` closes the period ended by the
`MEMBERSHIP_REMOVED` fact before it (when that removal ended an `ACTIVE` Membership). The period
starts at the last `MEMBERSHIP_ACTIVATED` fact from `PENDING_KEY_GRANT` before the removal, or at
the Membership's creation for a Team's founding owner. Audit receipt times are transaction start
times, close to but not identical with the overwritten row timestamps.

## Alternatives considered

- **A new Membership row per stint.** Keeping the removed row and inserting another would need a
  partial unique index on active rows and a review of every query that assumes one row per Team
  and User (authorization, listings, provisioning, idempotent replays). More churn for the same
  result.
- **Deriving windows from Audit Facts on every read.** Audit receipt times are not the row
  timestamps the client compares against, and reading audit history on every boundary request is
  needlessly expensive. The facts serve only the one-time backfill.

## Consequences

- A Member removed and invited back keeps every earlier Revision verifiable; a Revision authored
  between two periods is still refused.
- Membership windows still come from the service (ADR 0015 does not cover them).
- `docs/administration.md` now says removed Memberships can be revived by a new invitation.
- CLI and web must forward `membershipPeriods` into `RevisionSigningTrustEntry` (and must not
  deduplicate entries in a way that drops it) to verify history from earlier periods.
