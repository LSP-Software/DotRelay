# Administration policy

Team, Membership, Project, and Environment administration is enforced from persisted DotRelay
state. GitHub supplies stable subjects for Membership Invitations and stable repository ids for
Project linkage. GitHub repository admission, team membership, names, and permissions never grant
DotRelay authority.

## Membership roles and lifecycle

Team creation and its first active owner Membership commit atomically. A Team must always retain at
least one active owner. Memberships move forward from `PENDING_KEY_GRANT` to `ACTIVE` or to
`REMOVED`. A removed Membership is a durable record; accepting a new invitation revives the same
row as a `MEMBER` in `PENDING_KEY_GRANT`. Before the revival, the finished active period is archived
in `membership_periods`, so the User's earlier Revisions stay verifiable against the period they
were signed in ([ADR 0017](adr/0017-membership-periods-survive-reinvitation.md)). Only active
Memberships authorize reads or mutations.

| Capability                                       | Owner | Admin | Member |
| ------------------------------------------------ | ----- | ----- | ------ |
| View Team and active Project/Environment content | yes   | yes   | yes    |
| Publish Revisions and roll back an Environment   | yes   | yes   | yes    |
| Invite a Member or revoke a pending invitation   | yes   | yes   | no     |
| Remove a Member                                  | yes   | yes   | no     |
| Change Member/Admin/owner roles                  | yes   | no    | no     |
| Create, archive, or restore a Project            | yes   | yes   | no     |
| Create, archive, or restore an Environment       | yes   | yes   | no     |
| Rotate a Project's epoch key                     | yes   | yes   | no     |

Publishing and Rollback need an active Membership and an active Device, whatever the role. A
Revision's authored-at instant must not precede the signing Device's activation, the author's
Membership activation, or the parent Revision, and must not lie more than ten minutes past the
service clock; the service refuses anything else with `authored_at_out_of_range` (409) instead of
committing a head every client would reject.

### Owed rotations

Removing an active Member, or revoking an active Device, records a rotation owed by each Project
the removed party could read: every Project of the Team for a Member, every Project of the User's
active Teams for a Device. The workspace boundary reports the oldest outstanding one as
`environment.rotationOwed` (`since`, `sinceEpoch`, `membershipRemovals`, `deviceRevocations`, or
`null`). Rotating the Project's epoch clears every obligation recorded before the rotation. It is
advice for owners and admins: it never blocks publication, and the boundary's
`rotationRequired` publication gate stays `false` for it.

An admin cannot promote itself, manage owners/admins, or bypass last-owner protection. Role does
not broaden encrypted Value ownership: owners and admins cannot receive another User's User-defined
Value lane. An active authorized Device is additionally required at encrypted and administrative
mutation/read boundaries.

## Membership Invitations

A Membership Invitation is addressed to the invitee's stable GitHub provider subject, never a
mutable login or email address. The service sets expiry to exactly seven days after creation.
Acceptance must be performed once, before expiry, by the matching server-local User in the same
Server Profile. An active owner or admin can revoke a pending invitation
(`POST /api/v1/teams/:teamId/invitations/:invitationId/revoke`), and the addressed User can
decline it (`POST /api/v1/invitations/:invitationId/decline`); either ends it, is recorded as an
`INVITATION_REVOKED` or `INVITATION_DECLINED` Audit Fact, and makes acceptance answer
`invitation_expired`. A Team holds at most 50 pending invitations (unused, unexpired, not revoked
or declined); one more answers `pending_invitation_limit` (409). Expired invitations that were
never accepted are deleted by the retention job. It creates a Member Membership in `PENDING_KEY_GRANT`; GitHub admission alone does
not create or activate a Membership. Provisioning the complete required grant set and its signed
activation object moves that Membership to `ACTIVE`.

An unlocked owner/admin uses **Share project keys** in the Members view to provision every
initialized active Project to the invitee's active Devices and activate the Membership atomically.
The signed activation identifies the exact recipients and grant digests; the service derives the
required coverage from current persisted state instead of trusting a client-supplied count. The
same action on an active Member shares keys for newly initialized Projects or new Devices while
preserving the initial activation record. User-defined Value keys are never shared by this action.
See [alpha release operations](alpha-release.md) for admission, bounded request sizes, and Device
revocation procedures.

### Provisioning key trust

A Device that is not created by initial trust bootstrap joins through dual-control enrollment:
the prospective Device self-signs its enrollment request, one of the User's existing trusted
Devices (which may be the only one) approves it, and the Server Profile verifies the approval
against its stored trusted-Device keys before it persists the new Device's self-signed
certificate and X25519/Ed25519 keys. Initial trust
bootstrap is a separate, documented path: it requires only an authenticated session, is available
only for a User's first Device (a second bootstrap is rejected once an `ACTIVE` Device exists),
and creates the Device as `ACTIVE` without an enrollment record, because a User's first Device
has no trusted Device that could approve its enrollment (see
[initial trust bootstrap](wiki/trust.md#initial-trust-bootstrap) and
[ADR 0010](adr/0010-session-bootstrapped-devices-are-fully-active.md)). Revocation, re-approval,
and every later protocol boundary reuse those persisted keys.

**Share project keys** relies on the key binding the Server Profile has established for each
Device. The provisioning plan reports each recipient Device's X25519 public key as persisted for
that Device, and the owner's browser seals each Project key to the reported key. The browser
therefore trusts the Server Profile as the authority for Device key binding — the same trust it
places in the persisted Device keys the service discloses elsewhere (Device lists, peer Devices,
the workspace signing trust set). At commit time the service re-derives the plan from persisted
state inside the same transaction and rejects the activation unless every sealed grant names one
of the recipient Device's persisted X25519 keys, so a plan and its grants cannot be mixed across
Devices or Profiles. That re-derivation checks consistency within the service's own state: a
dishonest Server Profile that controls the stored keys could still steer a sealed Project key to
a key it controls. Enrollment or initial trust bootstrap is the trust anchor that makes a stored
key meaningful, and provisioning adds no trust subject beyond the Server Profile itself.

## Project and GitHub Repository identity

A Project belongs permanently to one Team and identifies one GitHub Repository by GitHub's stable
numeric repository id. Repository rename or transfer does not change that id or the Project.
Project `teamId` and `githubRepositoryId` are immutable after creation. At most one active Project
in a Team can use a stable repository id. Archiving releases that active linkage; restoring fails
closed while another active Project holds it.

GitHub Repository metadata is descriptive only. A User with repository admission but no active
Membership receives no Project or Environment disclosure or authorization.

The Client never calls the GitHub API and never sends a GitHub token. To resolve the descriptive
`owner/repo` name a Client read from its Git remote, the service answers
`GET /api/v1/github-repositories/resolve` for the acting protocol actor: it looks up the
Repository on that User's behalf with the fine-grained GitHub App grant the User made while
signing in (Delegated GitHub Access), and returns the current descriptive owner/name with GitHub's
stable numeric Repository Identity. Without Delegated GitHub Access for the User — or when GitHub
answers 403 or 404, which the endpoint conflates on purpose so it is not an existence oracle —
the service reports `repository_access_denied`. GitHub rate limits surface as
`github_rate_limited` with the retry window, and an unreachable or malformed GitHub answer as
`github_unavailable`; both are transient and leave established sync unaffected.

## Environment lifecycle and disclosure

An Environment belongs permanently to a Project and has `ACTIVE` or `ARCHIVED` metadata state.
Owners and admins explicitly create, archive, and restore Environments. An archived Environment
retains immutable history and its opaque identity, but its Manifest lanes are not disclosed until
restored; restoration also requires an active parent Project.

The service stores an operator-visible Environment label (default `default`) alongside opaque ids,
lifecycle, and current head. Variable naming and name uniqueness remain client-enforced against
verified encrypted Manifests. Operator-visible metadata is limited to opaque ids, Environment
label, lifecycle, current head, role, and Membership lifecycle. Read-side queries require an
active Membership and Device and exclude every User-defined Value lane not owned by the requesting
User before returning rows.
