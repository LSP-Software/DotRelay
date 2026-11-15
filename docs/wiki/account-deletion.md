# Account deletion, Team deletion, and data export

Technical facts for the privacy notice. The decisions are in
[ADR 0018](../adr/0018-account-deletion-keeps-public-verification-material.md) and
[ADR 0019](../adr/0019-leaving-and-deleting-a-team.md).

## Deleting an account

Self-service, in the web app's Account view or with `dotrelay account delete`. It takes effect at
once; there is no grace period and no undo. It is refused while the User is the last active owner
of a Team that has other Members.

Deleted immediately:

- the sign-in record: name, email address, avatar URL, GitHub account link and its OAuth tokens;
- the GitHub login cached for finding Members by login;
- every session, with its IP address and user agent;
- every Account Key Wrapper (password, passkey, Recovery Code), Account Key Envelope, and Account
  Key Transfer;
- every key grant sealed to the User's Devices;
- Device display names, operating system, and client summary;
- unaccepted invitations addressed to the User, unapproved Device enrollments, and uncommitted
  uploads;
- Teams where the User was the only Member (see Team deletion below).

Kept, because teammates' clients need it to verify history the User wrote:

- the User's opaque id, Server Profile id, creation time, and deletion time; the GitHub id is
  replaced by a tombstone;
- each Device's opaque id, public keys, and activation and revocation times;
- the signed Account Device rosters and Device certificates (public keys only);
- Memberships: Team, role, and the times each period began and ended;
- Revisions the User authored, and the Shared Values they provided, which belong to the Team;
- Operations and Audit Facts: opaque ids, event kinds, and times.

None of the kept data is a credential, a secret, or contact data. User-defined Values the User
owned stay inside Revision history but are encrypted to a key only the User held; with every
wrapper and envelope deleted, no one can decrypt them, including the operator.

After deletion the User is shown to teammates as "Deleted user". A later sign-in with the same
GitHub account creates a new, unrelated User with new keys. A Device that kept its keys cannot
sign as the deleted User: every Device and Membership window closes at the deletion time.

Teammates keep whatever they already decrypted. Owners should rotate each affected Project's key.

## Leaving a Team

Ends the Membership as a removal does. The Membership row and its periods are kept, so the
User's Revisions in that Team stay verifiable. The Team's Projects owe a key rotation.

## Deleting a Team

An owner deletes a Team after typing its name. Every Membership ends and the Team is unreadable
at once. Its encrypted data (Projects, Environments, Revisions, keys, grants, Memberships,
invitations) is kept for **30 days**, then deleted by the retention job. Operations and Audit
Facts, which hold only opaque ids and times, stay. Database backups follow the operator's backup
retention ([operations](operations.md)).

## Data export

`GET /api/v1/account/export`, the Account view's **Export my data**, or `dotrelay account export`
returns JSON with: profile (name, email, avatar URL), linked GitHub account ids and scopes,
sessions (times, IP address, user agent), Memberships with roles and periods, invitations,
Devices with display metadata and lifecycle times, Account Key Wrapper types and times, Projects
created, the count and time range of Revisions authored, and the latest 1,000 Audit Facts the User
caused.

It contains no Values, ciphertext, wrapped keys, public keys, or tokens. The service cannot
decrypt Values; `dotrelay pull` or `dotrelay export` on one of the User's Devices exports them.
Exports are limited to 10 per hour per User.
