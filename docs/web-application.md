# Web application surface

The Next.js application is a dark-only browser client for one selected Server Profile. It provides
the public landing and GitHub sign-in routes plus a workspace-first shell for Team, Project, and
Environment context. It does not move authentication, authorization, cryptography, or persistence
authority into the web process.

## Visual system and information hierarchy

The UI uses Tailwind CSS and stock shadcn/ui Base Nova components added through the current shadcn
CLI. The application does not maintain light-mode tokens or a parallel bespoke component library.
Its dark operations-console direction uses neutral surfaces, high-contrast text, green for verified
trust/current state, amber for missing trust or Device requirements, and red only for destructive
lifecycle actions. Keyboard focus uses the same high-contrast green ring, and motion respects
`prefers-reduced-motion`.

The workspace presents information in this order:

1. selected Server Profile and Team / Project / Environment context;
2. Server Profile trust, browser session, and Device state as three separate signals;
3. protected-content availability and a stable API problem code when unavailable;
4. Revision continuity metadata and Project / GitHub Repository linkage disclosure;
5. non-secret Membership and resource administration;
6. Device authorization and Recovery Kit entry points.

Desktop navigation is persistent. The same landmarks are available from a keyboard-operable sheet
on narrow viewports, and a skip link moves focus directly to the workspace.

## Trust, session, Device, and cryptography

These states must not be collapsed into one signed-in indicator:

| State | Meaning | Permitted surface |
| --- | --- | --- |
| Server Profile pinned | Profile id and canonical origin were explicitly trusted | Credentials may be considered for that profile |
| Session active | Better Auth resolved one server-local User | Non-secret identity and eligible administration only |
| Active Device | This client installation is authorized for that User | Protected operations may proceed if all other gates pass |
| v3 cryptography available | The closed v3 WebCrypto suite is supported | Protected bytes may be requested and processed locally |

A session never implies an active Device. A GitHub identity never implies a DotRelay Membership.
Changing Server Profile selection surfaces a new trust decision instead of carrying ambient trust
across profiles.

When the v3 runtime or provider is unavailable, the shell reports the stable
`unsupported_crypto_runtime` or `crypto_provider_unavailable` problem and does not request or
render Manifest lanes, Variable names, Shared Values, or User-defined Values. The permitted surface
is limited to sign-in/out, profile selection and trust explanation, non-secret Team/Membership and
resource lifecycle metadata, invitation administration, Device authorization, Recovery Kit entry,
and stable problem guidance.

## Environment editor workflow

Once all protected gates pass, the Environment editor displays the verified head, current Project
epoch, Variables, descriptions, and the ownership of each Value lane. Values use password inputs and
remain masked until the active Device explicitly reveals one. A new Variable requires a valid name
and explicit Shared Value or User-defined Value classification; its definition and initial Value
lane enter the local draft together. Empty Values and absent optional Values remain distinct.

Review & publish shows the expected parent Revision, signing Device, changed-lane count, and a
zero-plaintext service boundary before the client encrypts changed lanes, signs the v3 mutation,
stages objects, and finalizes publication. A stale head becomes a local three-way conflict with
Keep local, Use remote, and Merge choices. Rollback is lane-scoped and always publishes a new
Revision, so the current head remains in immutable history. Archived resources, stale epochs,
missing grants, inactive Devices, unsupported crypto, and untrusted profiles keep this workflow
locked and disclose only actionable gate state.

## Role and lifecycle disclosure

The UI derives controls from the persisted Membership role. Owners can manage roles and all
administrative resources. Admins can invite/remove Members and administer Projects and
Environments, but cannot manage owners or admins. Members have view-only access to active Team
content. Disabled controls are accompanied by the active role disclosure; they are not presented as
an API authorization boundary.

Invitation creation accepts a stable GitHub provider subject, never an email or mutable login.
Acceptance is shown as `PENDING_KEY_GRANT` until the complete grant set activates the Membership.
GitHub Repository names and stable ids are descriptive and explicitly do not grant authority.

Project and Environment archive/restore actions require confirmation. The Environment confirmation
states that archiving retains immutable Revision history while preventing Manifest disclosure.
Project restoration states that a conflicting active stable GitHub Repository linkage fails closed.

## Browser quality boundary

Playwright coverage in `apps/web/e2e/workspace.spec.ts` exercises the public landing/sign-in flow,
role-aware invitation controls, pending key grants, Environment archive/restore confirmation,
Server Profile switching, keyboard and responsive navigation, Revision history, and the blocked
secret-access state. Tests observe browser-visible behavior and never reach into component state.
