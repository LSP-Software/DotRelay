# Web application and trust states

DotRelay's web application is dark-only. The workspace is Team-first, then Project, then
Environment. Stock shadcn/ui components, high-contrast surfaces, green verified-state signals,
amber only when there is a next action, keyboard focus, and reduced-motion support.

## Workspace hierarchy

The sidebar names the current Team and lets you switch. Projects for that Team are listed next to
Team, Devices, and Recovery. You pick a Project, then an Environment, then Variables. Desktop
navigation becomes a keyboard-operable sheet on small screens, and a skip link reaches the main
workspace.

A Project is listed by its linked GitHub owner and name when they are known, otherwise by
the stable numeric GitHub repository id. Environment tabs use the operator-visible label. Owners
and admins can create another Environment from those tabs, choosing a base Environment and whether
each Variable is copied, left blank, or omitted. Device approval lives at `/device` and is opened
from CLI setup or login.

The Devices page lists every enrolled Device for your User, including CLI
installations, and whether this browser is one of them.

## One next action

The interface still tracks four independent gates: Server Profile trust, session, Device, and
cryptography. Being signed in does not authorize a Device. Being known to GitHub does not create a
Membership.

The workspace shows only the next action the person can take. It does not stack overlapping
warnings or API problem codes. Enroll this browser, trust this Server Profile, sign in, or copy the
CLI command. Command snippets include a Copy control. `dotrelay setup <origin>` enrolls the CLI
Device. Enroll browser enrolls this browser as its own Device, including after the CLI is already
enrolled.

There is no reduced-security mode, alternate cryptographic suite, provider fallback, or server-side
plaintext rendering.

## Roles and lifecycle

Owners can manage roles, Members, Projects, and Environments. Admins can invite or remove Members
and administer Projects and Environments, but cannot manage owners or admins. Members can view
this Team's Projects.

Membership Invitations target a stable GitHub subject and expire after seven days. An accepted
invitation stays **Pending key grant** until all required grants activate the Membership.

Archive and restore operations require confirmation. Archiving an Environment keeps immutable
Revision history but hides Variables until restore. Restoring a Project fails closed if another
active Project holds the same stable GitHub Repository linkage.

## Environment editor

The editor is available only after Server Profile trust, WebCrypto, an active Device, required
grants, an active Project and Environment, and a current Project epoch. Values stay masked until
you reveal them on this Device.

New Variables require explicit ownership. Shared Values are Team-readable. A User-defined Value is
readable only by that User's authorized Devices. Live Variable names remain unique. Deletion stages
a tombstone until publication.

Save changes encrypts changed Values in the browser, then publishes a new Revision. Sync verifies
history before remote state is accepted. Stale heads require a local choice. Rollback chooses
Variables and appends a new Revision rather than rewinding the head.
