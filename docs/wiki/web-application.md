# Web application and trust states

DotRelay's web application is dark-only and workspace-first. Its Tailwind CSS interface uses stock
shadcn/ui components, with high-contrast neutral surfaces, green verified-state signals, amber trust
warnings, clear keyboard focus, and reduced-motion support.

## Workspace hierarchy

The shell keeps the selected Server Profile visible beside the current Team, Project, and
Environment. Revision history and administration are first-class navigation areas, followed by
Devices and Recovery. Desktop navigation becomes a keyboard-operable sheet on small screens, and a
skip link reaches the main workspace.

The Project panel discloses the linked GitHub Repository and stable repository id as descriptive
metadata. GitHub admission and permissions do not grant DotRelay access.

## Four independent gates

The interface reports four separate states:

- **Server Profile trust** pins one profile id and canonical origin.
- **Session** authenticates one server-local User through Better Auth and GitHub.
- **Device** authorizes one client installation for that User.
- **Cryptography** confirms the complete closed v3 WebCrypto suite is available.

Being signed in does not authorize a Device. Being known to GitHub does not create a Membership.
Selecting another Server Profile requires its own explicit trust decision.

## Roles and lifecycle

Owners can manage roles, Members, Projects, and Environments. Admins can invite or remove Members
and administer Projects and Environments, but cannot manage owners or admins. Members can view
active Team content only. These disclosures explain the controls; the API remains the authorization
boundary.

Membership Invitations target a stable GitHub subject and expire after seven days. An accepted
invitation stays **Pending key grant** until all required grants activate the Membership.

Archive and restore operations require confirmation. Archiving an Environment keeps immutable
Revision history but prevents its Manifest lanes from being disclosed. Restoring a Project fails
closed if another active Project holds the same stable GitHub Repository linkage.

## When protected access is unavailable

If there is no active Device or the required v3 cryptographic runtime/provider is unavailable, the
browser does not request or display Manifest lanes, Variable names, Shared Values, or User-defined
Values. It shows a stable API problem code and leaves only permitted non-secret actions: sign-in and
profile trust, role/lifecycle metadata, invitations, archive/restore administration, Device
authorization, and Recovery Kit entry.

There is no reduced-security mode, alternate cryptographic suite, provider fallback, or server-side
plaintext rendering.

## Environment editor

The protected editor is available only after Server Profile trust, v3 runtime verification, an
active Device, required grants, active resource state, and a current Project epoch all pass. It
shows verified-head metadata and Variable definitions while keeping Values masked by default.
Reveal is an explicit per-Value action on the active Device and is never an output path for
diagnostics or logs.

New Variables require explicit ownership classification. Shared Values are Team-readable; a
User-defined Value is readable only by that User's authorized Devices. Definitions and their
required initial Value lanes are added atomically to the local draft, preserving exact UTF-8 and
empty-versus-absent semantics.

Review & publish displays the expected parent, signing Device, changed lanes, and the client-only
encryption boundary before staging and finalizing a signed v3 mutation. Stale heads require local
three-way resolution. Rollback chooses lanes and appends a new Revision rather than rewinding the
head. Unsupported crypto, inactive Devices, pending grants, archived resources, stale epochs, and
required rotation fail closed without requesting protected content.
