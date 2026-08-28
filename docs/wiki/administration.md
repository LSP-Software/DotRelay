# Team and resource administration

DotRelay authorization comes only from persisted Memberships. GitHub provides the stable identity
used to address a Membership Invitation and the stable repository id linked to a Project. GitHub
repository admission and GitHub permissions never grant DotRelay access.

## Roles and Membership state

Creating a Team atomically creates its first active owner, and every Team must retain an active
owner. A Membership is `PENDING_KEY_GRANT`, `ACTIVE`, or `REMOVED`; only `ACTIVE` authorizes access.

| Capability | Owner | Admin | Member |
| --- | --- | --- | --- |
| View Team content | yes | yes | yes |
| Invite/remove Members | yes | yes | no |
| Manage admins and owners | yes | no | no |
| Administer Projects and Environments | yes | yes | no |

Membership Invitations target a stable GitHub provider subject, expire exactly seven days after
creation, and are single-use. The matching User accepts the invitation to create a
`PENDING_KEY_GRANT` Member Membership. It becomes `ACTIVE` only after the required encrypted grants
and signed activation object are complete.

Owners and admins do not gain access to another User's User-defined Values. Authorization checks
also require an active Device where protected data or an administrative mutation is involved.

## Project linkage

A Project remains in its original Team and is linked permanently to a GitHub Repository's stable
numeric id. Repository rename or transfer therefore preserves Project identity. A Team can have at
most one active Project for that id. Archiving releases the active linkage; restoring fails while a
replacement is active. GitHub repository metadata remains descriptive and never authorizes access.

## Environment lifecycle

An Environment is created, archived, or restored explicitly by a Team owner or admin. Archive is
logical: immutable Revisions remain retained, but Manifest lanes are not disclosed until the
Environment is restored under an active Project.

The service stores opaque Environment ids, lifecycle, and current-head metadata, but no readable
Environment name. Clients enforce names against verified encrypted Manifests. Operator-visible
authorization state is limited to opaque resource ids, role, Membership lifecycle, resource
lifecycle, and current head. Read queries exclude User-defined Value lanes owned by anyone other
than the requesting User before returning data.
