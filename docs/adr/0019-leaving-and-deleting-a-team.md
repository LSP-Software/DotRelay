# Leaving and deleting a Team

Status: accepted

Members could only be removed by an owner or admin, and a Team could not be deleted at all. A
public service needs both as self-service actions, without weakening the signed history the
rest of the Team relies on.

## Leaving

`POST /api/v1/teams/:teamId/leave` ends the caller's own Membership (session only, so a Member still
waiting for keys can leave) through the same repository
path as removal: the row becomes `REMOVED`, a `MEMBERSHIP_REMOVED` Audit Fact is recorded with the
leaver as actor, and when the Membership was `ACTIVE` each Project of the Team owes a rotation
(`rotationOwed`). No grants are deleted; the leaver simply receives no key for a later epoch.

Any Member may leave, whatever their role, except the Team's last active owner while any other
Member remains, or the Team's only Member. Both answer `owner_transfer_required` (409): promote
another active Member to owner, or delete the Team. The database last-owner trigger stays as a
backstop.

## Deleting a Team

`POST /api/v1/teams/:teamId/delete` is owner-only and requires an active Device. The body repeats the
Team name (`confirmName`), which clients ask the owner to type.

Deletion is a soft delete that takes effect at once:

- `teams.lifecycle` becomes `ARCHIVED` and the new `teams.deletedAt` is set. Every read and
  mutation already requires an `ACTIVE` Team or an active Membership.
- Every Membership that is not removed becomes `REMOVED` at the deletion time.
- Pending invitations are revoked.
- A `TEAM_DELETED` Audit Fact is recorded.

Nobody, including the owner, can read the Team's Projects, Environments, or Revisions afterwards.
The service still holds the ciphertext for **30 days** (`TEAM_PURGE_AFTER_MS`). The retention job
then hard-deletes the Team: its Projects, Environments, Revisions, lanes, grants, key links,
envelopes for its Projects, activation objects, rotation obligations, invitations, Memberships,
Membership periods, and the Team row. Operations and Audit Facts stay; they hold only opaque ids.

The window lets an operator restore a Team deleted by mistake from a database backup without a
dedicated undo flow. There is no self-service restore.

### Purging append-only rows

Protocol objects, Revisions, lanes, grants, and Membership periods are protected by
`dotrelay_reject_immutable_row()`. The purge sets the transaction-local setting
`dotrelay.purge = 'on'`, which that function now allows. Nothing else sets it, so ordinary code
paths still cannot change history. The last-owner triggers ignore Teams that are not `ACTIVE`.

## Alternatives considered

- **Immediate hard delete.** No room to recover from a mistaken or malicious owner action.
- **Soft delete only.** Keeps ciphertext forever for a Team nobody can use, which a privacy
  notice would have to justify.
- **A new `DELETED` Team lifecycle.** Every existing `lifecycle: "ACTIVE"` filter already
  excludes a deleted Team when it is `ARCHIVED`; a separate `deletedAt` distinguishes the two
  without touching those queries.

## Consequences

- The 30-day window is a product choice; operators and the privacy notice should state it.
- Account deletion (ADR 0018) deletes the User's sole-member Teams through this path.
