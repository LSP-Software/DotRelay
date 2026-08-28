# Administration policy

Team, Membership, Project, and Environment administration is enforced from persisted DotRelay
state. GitHub supplies stable subjects for Membership Invitations and stable repository ids for
Project linkage. GitHub repository admission, team membership, names, and permissions never grant
DotRelay authority.

## Membership roles and lifecycle

Team creation and its first active owner Membership commit atomically. A Team must always retain at
least one active owner. Memberships move forward from `PENDING_KEY_GRANT` to `ACTIVE` or to
`REMOVED`; removed Memberships are durable records and are not reactivated. Only active
Memberships authorize reads or mutations.

| Capability | Owner | Admin | Member |
| --- | --- | --- | --- |
| View Team and active Project/Environment content | yes | yes | yes |
| Invite a Member | yes | yes | no |
| Remove a Member | yes | yes | no |
| Change Member/Admin/owner roles | yes | no | no |
| Create, archive, or restore a Project | yes | yes | no |
| Create, archive, or restore an Environment | yes | yes | no |

An admin cannot promote itself, manage owners/admins, or bypass last-owner protection. Role does
not broaden encrypted Value ownership: owners and admins cannot receive another User's User-defined
Value lane. An active authorized Device is additionally required at encrypted and administrative
mutation/read boundaries.

## Membership Invitations

A Membership Invitation is addressed to the invitee's stable GitHub provider subject, never a
mutable login or email address. The service sets expiry to exactly seven days after creation.
Acceptance must be performed once, before expiry, by the matching server-local User in the same
Server Profile. It creates a Member Membership in `PENDING_KEY_GRANT`; GitHub admission alone does
not create or activate a Membership. Provisioning the complete required grant set and its signed
activation object moves that Membership to `ACTIVE`.

## Project and GitHub Repository identity

A Project belongs permanently to one Team and identifies one GitHub Repository by GitHub's stable
numeric repository id. Repository rename or transfer does not change that id or the Project.
Project `teamId` and `githubRepositoryId` are immutable after creation. At most one active Project
in a Team can use a stable repository id. Archiving releases that active linkage; restoring fails
closed while another active Project holds it.

GitHub Repository metadata is descriptive only. A User with repository admission but no active
Membership receives no Project or Environment disclosure or authorization.

## Environment lifecycle and disclosure

An Environment belongs permanently to a Project and has `ACTIVE` or `ARCHIVED` metadata state.
Owners and admins explicitly create, archive, and restore Environments. An archived Environment
retains immutable history and its opaque identity, but its Manifest lanes are not disclosed until
restored; restoration also requires an active parent Project.

The service stores no readable Environment name. Naming and name uniqueness are client-enforced
against verified encrypted Manifests. Operator-visible metadata is limited to opaque ids, lifecycle,
current head, role, and Membership lifecycle. Read-side queries require an active Membership and
Device and exclude every User-defined Value lane not owned by the requesting User before returning
rows.
