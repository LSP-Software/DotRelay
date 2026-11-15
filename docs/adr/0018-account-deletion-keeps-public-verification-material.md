# Account deletion keeps public verification material

Status: accepted

A User can delete their account. Every Revision is signed by its author's Device and verified by
every teammate's client against the author's signed Account Device roster (ADR 0015) and Membership
periods (ADR 0017). If deletion removed the author's Device keys, roster, or Membership rows, every
teammate's client would refuse the history that User wrote. If deletion left the account usable,
anyone holding its session or a Device could keep acting as it.

## Decision

Account deletion is immediate and self-service (`POST /api/v1/account/delete`). It needs a
signed-in session but no Device, so a User who lost every Device can still delete; the body must
repeat the User's id, and clients ask the User to type a confirmation phrase first. It runs in one transaction and ends with the account
permanently unusable. It splits the User's server-held data into what is deleted and the minimum
kept so teammates can still verify history.

### Preconditions

- A Team where the User is the only active owner and other Members (active or pending) remain
  blocks deletion with `owner_transfer_required` (409). The User promotes another active Member to
  owner, or deletes the Team, first.
- A Team where the User is the only remaining Member is deleted with the account
  ([ADR 0019](0019-leaving-and-deleting-a-team.md)).

### Deleted

| Data                                                   | How                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Better Auth user, sessions, linked GitHub account      | Row deleted; sessions, OAuth tokens and device codes cascade. Signs out every client |
| GitHub email, name, avatar                             | Held only on the Better Auth user, so deleted with it                                |
| Account Key Wrappers (password, passkey, Recovery Code) | Projection rows and their protocol objects deleted                                   |
| Account Key Envelopes (Project Epoch, User Value Keys)  | Projection rows and their protocol objects deleted                                   |
| Account Key Transfers                                   | Projection rows and their protocol objects deleted                                   |
| Grants sealed to the User's Devices                     | Projection rows and their protocol objects deleted                                   |
| Uncommitted staged objects of the User's Devices        | Deleted                                                                              |
| Unapproved Device enrollments                           | Deleted                                                                              |
| Unaccepted invitations addressed to the User            | Deleted                                                                              |
| Device display metadata (name, OS, client summary)      | Cleared                                                                              |

Deleting every wrapper, envelope, and grant leaves no server-held path to the Account Master Key
or to a key sealed for this User. User-defined Value lanes the User owned stay in Revision history
(Revisions commit to them), but they are sealed to the User's Value Key, which nobody else holds:
the ciphertext is unreadable to everyone, including the operator.

### Kept, and why

| Data                                                            | Why                                                                     |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `users` row: id, Server Profile, `createdAt`, new `deletedAt`   | Revisions, rosters, Devices, Memberships, Audit Facts reference the id  |
| Device rows: id, public keys, activation and revocation times   | Teammates verify the User's Revision signatures with them              |
| Device certificates, identity objects, Account Device rosters   | Signed public keys; the roster is what clients trust Device keys from   |
| Memberships (role, lifecycle, times) and Membership periods     | Signing windows for the User's Revisions (ADR 0017)                     |
| Revisions, lanes, Shared Values the User provided               | Team data: the Team's history, not the User's personal data              |
| Operations and Audit Facts                                      | Opaque ids and times only; idempotency guards and the security record   |

None of the kept material is a credential or a secret. It is public keys, opaque UUIDs, roles, and
timestamps, and every item is needed to verify or explain the Team's retained history.

### Unusable afterwards

In the same transaction the service:

- revokes every Device that is not already revoked (`revokedAt` = deletion time), so no Device can
  authenticate a protocol request, and teammates' clients close each Device window at that time;
- ends every Membership as removal does, with rotation owed by each Project the User could read;
- replaces `authSubject` and `githubSubject` with the tombstone `deleted:<user id>`, so no Better
  Auth user and no GitHub identity maps to the row again.

Signing in later with the same GitHub identity creates a new Better Auth user and a new `User`
with a new id, new Account Master Key, and new account identity. Teammates who pinned the old
identity see a different User, not a changed identity for the old one.

### Forgery

The service never held the deleted User's Device private keys or Account Master Key, so it cannot
sign a Revision or a roster in their name before or after deletion. A Device that still holds its
private key (a lost laptop) can sign, but every Membership period of the User is closed at the
deletion time and every Device window ends there, so clients refuse anything it authors later.

### Display

The Members list returns `deleted: true` and no name or avatar for a deleted User. Clients label
the author of their Revisions "Deleted user".

## Alternatives considered

- **Delete the `users` row and everything referencing it.** Every Revision the User wrote, and
  every later Revision chained to it, would stop verifying for the whole Team.
- **Grace period before deletion.** A pending deletion still holds credentials and keys, and
  restoring it needs a support process. The typed confirmation is the safeguard; the Recovery
  Code does not survive deletion.
- **Re-encrypting or re-signing history under another User.** Impossible without the author's key,
  and it would rewrite signed history.

## Consequences

- `docs/wiki/account-deletion.md` lists the retained fields for the privacy notice.
- Decrypted Values are never exported by the service. A User who wants a copy runs `dotrelay pull`
  or `dotrelay export` on a Device before deleting.
- Teammates should rotate the Projects the User could read, as after any removal.
