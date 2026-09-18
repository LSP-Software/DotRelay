# Web application surface

The Next.js application is a dark-only browser client for the one Server Profile its deployment
is bound to. It provides the public landing and GitHub sign-in routes plus a workspace-first shell
for Team, Project, and Environment context. It does not move authentication, authorization,
cryptography, or persistence authority into the web process.

## Visual system and information hierarchy

The UI uses Tailwind CSS and stock shadcn/ui Base Nova components added through the current shadcn
CLI. The application does not maintain light-mode tokens or a parallel bespoke component library.
Its dark operations-console direction uses neutral surfaces, high-contrast text, green for verified
trust/current state, amber for missing trust or Device requirements, and red only for destructive
lifecycle actions. Keyboard focus uses the same high-contrast green ring, and motion respects
`prefers-reduced-motion`.

Example commands (CLI setup, pull, or recovery instructions) are never shown as bare text. A
command embedded in a sentence renders as an inline code chip; a command on its own line renders
as a terminal line with a `$` prompt. Both offer click-to-copy with a hover tooltip and confirm
the copy in place.

The workspace presents information in this order:

1. the deployment's Server Profile and Team / Project / Environment context;
2. Server Profile trust, browser session, and Device state as three separate signals;
3. protected-content availability and a stable API problem code when unavailable;
4. Revision continuity metadata;
5. non-secret Membership and resource administration;
6. Device authorization and Recovery Kit entry points.

Desktop navigation is persistent. The same landmarks are available from a keyboard-operable sheet
on narrow viewports, and a skip link moves focus directly to the workspace.

## Trust, session, Device, and cryptography

These states must not be collapsed into one signed-in indicator:

| State | Meaning | Permitted surface |
| --- | --- | --- |
| Server Profile pinned | The hosted profile is trusted by default; a self-hosted profile was explicitly trusted for this browser session | Credentials may be considered for that profile |
| Session active | Better Auth resolved one server-local User | Non-secret identity and eligible administration only |
| Active Device | This client installation is authorized for that User | Protected operations may proceed if all other gates pass |
| v3 cryptography available | The closed v3 WebCrypto suite is supported | Protected bytes may be requested and processed locally |

A session never implies an active Device. A GitHub identity never implies a DotRelay Membership.
A web deployment is bound to the Server Profile behind it, and the browser offers no choice of
server. DotRelay's own hosted profile is trusted by default; a self-hosted profile requires an
explicit trust decision before protected content becomes available. Only the development fixture
keeps a Server Profile preview selector, so hosted and self-hosted behavior can both be
exercised locally.

When the v3 runtime or provider is unavailable, the shell reports the stable
`unsupported_crypto_runtime` or `crypto_provider_unavailable` problem and does not request or
render Manifest lanes, Variable names, Shared Values, or User-defined Values. The permitted surface
is limited to sign-in/out and trust explanation, non-secret Team/Membership and
resource lifecycle metadata, invitation administration, Device authorization, Recovery Kit entry,
and stable problem guidance.

## Environment editor workflow

Until the current Environment's Manifest has been read and verified, the editor shows a loading
state instead of an empty Manifest and blocks editing, adding Variables, rollback, and
publication. A failed read is disclosed as a read failure with a retry action; it is never
presented as an empty Manifest or as an editable state, so a populated but unreadable Environment
cannot publish a replacement draft. A verified empty Environment supports genesis creation. Local
edits made while a read is still pending are preserved and layered over the arriving verified
page instead of discarding it.

Once all protected gates pass, the Environment editor displays the verified head, current Project
epoch, Variables, descriptions, and the ownership of each Value lane. Values use password inputs and
remain masked until the active Device explicitly reveals one. A new Variable requires a valid name
and explicit Shared Value or User-defined Value classification; its definition and initial Value
lane enter the local draft together. Empty Values and absent optional Values remain distinct.
Live Variable names are unique within the Manifest. Deletion creates a tombstone in the draft so
the definition is not silently reused or removed from immutable history.

Save changes shows the draft Variable diffs and publishes a new Revision. A live protocol session
then encrypts each changed definition and Value lane, signs the v3 mutation with the active Device
key, begins an idempotent operation, stages immutable objects, and finalizes with compare-and-swap
head checks. The client verifies sync object digests, manifest hashes, and revision links before
accepting remote state. A stale head becomes a local conflict: the editor shows the local draft
side and the verified remote side of each contended Variable as a masked comparison with an
explicit reveal, labels whether the difference is a Value, a definition (ownership/description), or
a deletion, and explains the Value and definition consequence of each Keep mine / Use theirs /
Keep my value choice. A choice can be revisited before publication, and retrying the publish
re-runs the approved publication against the re-anchored head rather than only re-arming the
 publish gate. Rollback is lane-scoped and always publishes a new Revision, so the current head
 remains in immutable history. The History card lists the verified Revisions with their authored
 time, change kind (naming the target of a Rollback), and author where the protocol provides
 them, an honest unavailable label where it does not, and a short id suffix so a Revision can be
 referenced without memorizing its full id. The rollback dialog identifies the target Revision and
 previews the masked consequence of the selected lanes — a new Rollback revision that restores
 only the chosen Variables — before it is staged. Reading a target Revision's Values shows
 progress while the Device resolves them. If the Revision is missing from the Device's verified
 history, or an integrity or decryption check fails, the dialog reports the failure with a retry
 instead of claiming the Revision is unchanged: only a Variable verified absent from the Revision
 is left out of the preview, and a partial read names every Variable it could not resolve so it
 cannot imply a complete comparison. The development protected preview uses the same
 cryptographic artifact builder but is explicitly local and never reports a service publication.
Archived resources, stale epochs, missing grants, inactive Devices, unsupported crypto, and
untrusted profiles keep the live workflow locked and disclose only actionable gate state.

Unpublished drafts are retained per Environment while moving among workspace views and across
Projects and Environments within a Server Profile. Any action that would discard unpublished
work — including a Server Profile preview switch in the development fixture — warns first and
offers an explicit discard choice that names the affected Environments and, for a switch that
stays within a Server Profile, the changed Variables. Reloading or closing the page with a dirty
draft raises a `beforeunload` warning; the draft is discarded only if the user confirms. Draft
content stays in memory and is never written to unprotected browser storage in plaintext.

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

## Workspace availability and offline state

The workspace shell loads its context from the Server Profile through the workspace boundary
request. Outside an explicit development fixture (`DOTRELAY_WORKSPACE_FIXTURE=1`), the shell must
never substitute development fixture identity, Teams, Projects, or a signed-in session for a
failed request. A fresh visit that cannot verify the boundary renders a loading state first and
then a recoverable connection error; it shows no identity, Membership, Team, Project, or Device
data until a live or explicitly enabled fixture boundary is verified.

When a previously verified boundary can no longer be refreshed, the shell keeps the last verified
metadata visibly stale, offers a retry action, and reconnects automatically with capped
exponential backoff. A malformed or non-200 boundary response is treated as a failed request:
it can only degrade to the offline or stale state, never to fixture data.

## Device approval

The `/device` page approves the device authorization code a CLI shows. It checks the code's
status and the browser session together, and renders each outcome as its own state instead of
collapsing them. The GitHub sign-in control appears only when the code is pending and the browser
session is genuinely absent; that sign-in returns to the same code. A pending code offers the
allow action to a signed-in session. Approved and denied codes finish as completed outcomes.
Expired and invalid codes finish with the return-to-CLI instruction to get a new code, and never
send the user back into sign-in. A connection or server failure while checking or approving
preserves the code, reports its state as unknown rather than guessing it, and offers an explicit
retry; an approval that reports a lapsed session or a processed code re-derives the state from a
fresh check. The page asks the user to verify the code their CLI shows instead of asserting where
the CLI is running. The API passes only the stable device authorization error codes (plus
`invalid_request`, `unauthorized`, and `device_code_already_processed`) through its auth
sanitization on the device verify/approve/deny routes; other auth endpoints keep the generic
problem response, and no Better Auth detail text is ever exposed.

## Browser quality boundary

Playwright coverage in `apps/web/e2e/workspace.spec.ts` exercises the public landing/sign-in flow,
role-aware invitation controls, pending key grants, Environment archive/restore confirmation, the
development fixture's Server Profile preview, keyboard and responsive navigation, Revision
history, enrolled Device listing, and the blocked secret-access state. `apps/web/e2e/workspace-offline.spec.ts` adds the
offline and stale connection states: an unreachable, malformed, or non-200 boundary response on
a fresh visit, and a failed refresh that keeps last verified data stale until automatic
reconnection or an explicit retry succeeds. `apps/web/e2e/workspace-draft-protection.spec.ts`
covers unpublished draft protection: drafts survive subview navigation and return, reload/close
warns only while a draft is dirty and keeps or discards it on the user's choice, discard
prompts name the affected Environments and, within a Server Profile, the changed Variables, a
Server Profile preview switch in the development fixture with a dirty draft requires an explicit
discard, and draft Values never appear in browser storage. `apps/web/e2e/workspace-history.spec.ts`
keeps the workspace location, URL, and browser history in sync: Back/Forward traverses the
workspace views and the selected Environment, a reload or shared link reopens the visible view
and Server Profile, a link to a deleted Team, Project, or Environment shows a recovery notice
instead of a blank page, and history navigation preserves dirty drafts or, for a Server Profile
rebind in the development fixture, prompts so dismissing it returns to the entry left behind. `apps/web/e2e/workspace-protocol-read.spec.ts` covers the Environment
read states with a live protocol session: a slow initial read shows the loading state instead of
the empty-claim, and a failed read discloses the failure with a retry action while Add Variable,
Save changes, and per-Variable edits stay blocked; retry re-enters the loading state.
`apps/web/e2e/workspace-protocol-reread.spec.ts` extends this to a verified read that later
fails: the Variables it loaded stay visible but locked, with each Variable's Value input,
reveal, Set absent, delete, and Undo delete controls disabled until the read recovers.
`apps/web/e2e/workspace-protocol-publish.spec.ts` covers a delayed publication over a live
protocol session: closing the review dialog while the publication is in flight neither cancels
nor misrepresents it, and a Value edited after the submitted snapshot is published stays visibly
marked as an unpublished draft while the published lane clears and the remote baseline becomes
the published snapshot. `apps/web/e2e/device-authorization.spec.ts` covers the device approval
states: a pending code offers the allow action only to a signed-in session and the sign-in
control only when the session is genuinely absent, an expired or invalid code finishes with the
return-to-CLI instruction without re-offering sign-in, an already-approved code finishes as
completed, and a transient check or approval failure preserves the code and recovers through an
explicit retry, including a lapsed session that returns to the sign-in control.
`apps/web/e2e/workspace-small-viewport.spec.ts` covers small-viewport and zoom reachability:
the Add Variable dialog stays inside the viewport on short phone heights and at 200% zoom,
its body scrolls, a focused field — including the last field — scrolls into view above the
pinned footer, and its Cancel/Add actions stay visible, including while the visible
viewport shrinks as an on-screen keyboard raises (Playwright cannot shrink only the visual
viewport, so the keyboard is simulated by resizing the viewport), whether before or after
the field is focused. Desktop and mobile navigation keep Devices and Recovery reachable
with a long Project list. `apps/web/e2e/workspace-invitations.spec.ts` covers the Team
invitation lifecycle against the service's API: a failed GitHub login resolution keeps the
form on the login field with an actionable explanation and never creates an invitation, a
rejected creation keeps the resolved identity and the service's error ready to retry, the
Members table reads the Team's persisted record and survives reloads and Team switching,
and an invitee who has not joined a Team sees the invitation addressed to them and, after
the service confirms acceptance, the record moves to the pending key-grant state.
Tests observe browser-visible behavior and never
reach into component state.
