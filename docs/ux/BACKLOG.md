# DotRelay UX backlog

Every finding lists enough state to reproduce it in the running application
(see `docs/ux/TOOLING.md` for how to start it). Prioritisation order:
blocked user > no obvious next action > wrong flow > missing core action >
misleading/dangerous behaviour > broken state handling > navigation/IA >
large friction > confusing interaction > terminology/copy > visual hierarchy
> minor polish.

## UX-001 - Signed-in users have no way to sign out
Journey:
ACCOUNT / SECURITY - account menu, sign out.
State:
Signed in on any profile (hosted or self-hosted). Desktop (sidebar) and mobile
(sheet) both affected.
Severity:
HIGH
Observed:
The workspace sidebar's account block is a static avatar + name + status line.
It is not a control: no menu, no sign-out action, nothing else. The mobile
navigation sheet has the same dead block. The only way to sign out was to
manually delete the session cookie or close the browser. The sign-in page has
the GitHub button, but a user who is already signed in has no path back to it.
User consequence:
A user who signs in with the wrong GitHub account, or who shares a machine,
cannot log out and switch accounts. They are stuck in the signed-in state with
no visible exit. For a tool that brokers secrets, being unable to end a
session is a real trust problem.
Expected:
A signed-in account block that opens a small menu containing "Sign out".
Signing out ends the account session (API-origin auth), leaves the browser's
device keys and trust decisions intact (same as closing the tab), and lands on
the sign-in page. The same action is available from the mobile navigation
sheet.
Evidence:
`GET /api/workspace/boundary` reports `session.active: true` for the signed-in
fixture, yet the account block renders only a static avatar and the text
"Signed in" with no interactive control (aria snapshot: no button/combobox for
the account, only the team combobox). The sign-in page is unreachable from the
workspace UI.
Status:
FIXED - implemented as a dropdown on the sidebar account block (desktop) and a
sign-out button at the bottom of the navigation sheet (mobile). Verified by
`apps/web/e2e/workspace-account.spec.ts` (desktop menu and mobile sheet both
sign out and land on /sign-in) and by browser observation. Committed on main.
See DECISIONS.md (D-001) for the chosen shape and the security notes.

## UX-002 - Long "Loading workspace..." after reload (environment quirk, not shipped behaviour)
Journey:
NORMAL USE - sign in / return to workspace after reload.
State:
Reproduced in the local audit environment with a long-lived browser tab
across repeated reloads.
Severity:
LOW (not observed on a fresh tab)
Observed:
In a tab kept open across many reloads during this audit, the workspace stayed
on "Loading workspace..." with a stale signed-out boundary for well over a
minute, while `curl` of `/api/workspace/boundary?profile=self-hosted` returned
the signed-in fixture boundary in ~2 ms. A brand-new tab settles to signed-in
within a few seconds.
User consequence:
If real users ever experience a boundary fetch that never resolves (hung
device provisioning or a stuck fetch), they would see an indeterminate loading
state with no progress signal and no retry.
Expected:
Keep an upper bound on how long the shell waits on the boundary; after it,
show a concrete "Couldn't connect to the server" state with a retry action
instead of an open-ended spinner.
Evidence:
Server logs show `GET /api/workspace/boundary?profile=self-hosted 200 in 2ms`
while the page stayed in the loading state; a fresh tab in the same environment
settled to signed-in quickly, pointing at stale tab state (device header /
boundary state) rather than a code regression.
Status:
FIXED - the shell now bounds the initial loading state: if the boundary is
still unverified 8 seconds after load (a healthy load resolves in well under a
second, so at that point the fetch has hung), the open-ended "Loading
workspace…" spinner switches to a concrete "Still connecting to the server"
state with a "Try again" retry (the existing reconnect path). A profile
rebind restarts the stall episode. Verified in a real browser by intercepting
the first two `/api/workspace/boundary` fetches and hanging them: the stalled
state appeared ~8s after reload and clicking "Try again" settled the
workspace; a healthy load settles instantly and never trips the stall.
Committed on main.

## UX-003 - Signed-in user with zero Teams is shown a dead "Choose a team" selector
Journey:
FIRST USE - sign in, zero teams.
State:
Signed in (any profile), belonging to no Team yet - e.g. a new user who
signed in through the web app before running any CLI command. The boundary
reports `session.active: true` and `catalog.teams: []`.
Severity:
HIGH
Observed:
The workspace renders the team view with a "Choose a team" heading, an empty
"Team" `<select>` in the sidebar (and again in the mobile navigation sheet),
and a dead "No projects yet / run dotrelay init" card. The heading implies the
user should choose a team, but the selector is empty and offers nothing to
choose. The two screens contradict each other: the heading says "choose", the
body says "there is nothing here, run the CLI".
User consequence:
A brand-new user who signed in via the web (the most obvious first action) is
stuck at a screen that tells them to choose a team that does not exist, while
the actual next step - running `dotrelay init` in a repository - is buried in
a subordinate card. This is the exact "empty Choose-a-team selector" trap the
audit brief calls out.
Expected:
When there are no Teams, the workspace stops pretending the user is choosing
among Teams: it hides the empty team selector (sidebar, mobile sheet, header
crumb) and shows one clear next action - create your first Team/Project/
Environment by running `dotrelay init`. The CLI, not a web form, is where Teams
and Projects are created; the web UI manages variables of existing Projects.
Evidence:
Reproduced in e2e by intercepting `/api/workspace/boundary` to return the
fixture boundary with `catalog` zeroed (a signed-in, online, zero-Teams state);
the page previously rendered the dead selector. See
`apps/web/e2e/workspace-zero-teams.spec.ts`.
Status:
FIXED - the zero-Teams state now hides every "choose a team" control and shows
a single "No teams yet" empty state pointing at `dotrelay init`. Verified in
e2e (the zero-Teams state points at the CLI and shows no team selector; a
user with Teams keeps the selector). Committed on main. See DECISIONS.md (D-002).

## UX-004 - Environment view's setup card contradicts itself (browser vs CLI)
Journey:
FIRST USE / NORMAL USE - open a project's environment before this browser has
enrolled a device.
State:
Signed in, server trusted, on a project environment, with no device enrolled in
this browser (fresh profile, or a browser that hasn't run the CLI). The
environment is locked (variables hidden) and the setup card is shown.
Severity:
MEDIUM
Observed:
The locked-environment card is titled "Set up this browser" and its button says
"Set up browser", but the label above the visible command said "Use the CLI on
this machine instead of this browser:" followed by `dotrelay setup …`. Three
signals pointed in different directions: the card is about setting up *this
browser*, yet its body told the user to use the CLI *instead of* this browser.
The shell's Devices view framed the same CLI alternative correctly ("Prefer the
CLI? It sets up the CLI on this machine, not this browser."), so the two
surfaces were inconsistent.
User consequence:
A fresh user trying to unlock their variables can't tell whether to click
"Set up browser" or run the CLI command. Following the title/button and then
reading the body yields two opposite instructions, which stalls the single most
important first-use step (getting this browser to read its values).
Expected:
The primary action (enrol this browser) is unambiguous, and the CLI command is
presented as an optional alternative for the same machine — not as something to
do "instead of" this browser. The environment view should match the Devices view
framing.
Evidence:
Browser observation: the environment card showed title "Set up this browser",
label "Use the CLI on this machine instead of this browser:", the
`dotrelay setup` command, and a "Set up browser" button simultaneously.
Status:
FIXED - the environment view's CLI label now reads "Prefer the CLI? It sets up
the CLI on this machine, not this browser." (same as the Devices view), removing
the contradiction. The `#cli-setup-command` test id and the button are unchanged,
so the CLI escape hatch still works. Verified by browser observation and the
environment/trust/enrollment e2e specs. Committed on main.

## UX-005 - Environment page: "Archive environment" renders as a full-width red bar
Journey:
NORMAL USE - open a project environment (the core screen for managing variables).
State:
Signed in, server trusted, a project with one or more environments is open.
Reproduces on any viewport below the `lg` (1024px) breakpoint - i.e. phones,
tablets, and narrow laptops (the workspace sidebar collapses under `lg` too).
Severity:
MEDIUM
Observed:
The environment page header is a `flex-col` layout below `lg` (it switches to a
row at `lg`). The "Archive environment" trigger is a `destructive`-variant
button that, in the column layout, stretches to full width (the container's
default `align-items: stretch`), rendering as a full-width red bar wedged
between the project title and the environment tabs - above the Variables card
where the user's actual task (view / add / edit / save variables) lives. It is
the most visually prominent control on the screen. At `lg+` the same control is
a normal-width button aligned to the right, so the full-width bar is a layout
artifact of the sub-`lg` breakpoint, not an intentional design.
User consequence:
On the product's core screen, a rare, reversible admin action (archive this
environment) visually dominates the user's primary task of managing variables.
A user skimming the screen meets a big red destructive control before anything
useful for what they came to do. This inverts the intended priority.
Expected:
The environment lifecycle control is a contained secondary control at every
breakpoint (its natural width, not a full-width bar), so it cannot out-shout the
user's core task. The confirm dialog that guards the actual archive/restore
action is unchanged.
Evidence:
Browser observation at an ~899px viewport on the production environment of
LSP-Software/DotRelay: a full-width red "Archive environment" bar sits directly
below the project title and above the production/staging tabs and the
set-up/variables card. At `lg+` the same control is a normal right-aligned
button.
Status:
FIXED - the environment page header now uses `items-start` for its sub-`lg`
column (overridden by the existing `lg:items-end lg:justify-between` on
desktop), so the archive/restore trigger keeps its natural width at every
breakpoint instead of stretching to a full-width bar below `lg`. The confirm
dialog and the button's role/label are unchanged. Verified with a Playwright
measurement at an 800px viewport (178px-wide button, left-aligned, not a
full-width bar) and at 1440px (right-aligned row, unchanged), plus the
environment/permissions e2e specs (20 passed). Committed on main.

## UX-006 - "Add variable" dialog masks the value with no way to check what was typed
Journey:
NORMAL USE - Add variable (dialog).
State:
Any editable environment, the "Add variable" dialog open; any value type
(shared or user-defined).
Severity:
MEDIUM
Observed:
The dialog's "Initial value" field is always `type="password"`, so whatever the
user types is rendered as dots with no reveal control. Every variable row in the
Variables card has an eye / eye-off reveal toggle (and a global "Reveal values"
control in the header), but the one place a value is *created* has none: the
user is typing a secret blind and cannot verify a character, a pasted token, or
a typo before the row is added to the draft. The placeholder also claims an
empty input saves "an empty string", which is true only while "Require a value"
is unchecked, so the placeholder and the checkbox below it can disagree.
User consequence:
On a product whose job is managing secrets, the creation surface gives the
least confidence of any value surface: a mistyped key or a mis-pasted token is
added to the draft, saved, and only discoverable after publishing, on a device
that actually consumes it. The affordance is inconsistent with the rest of the
same screen, which implies revealing values is something you do not get to do
here.
Expected:
The "Initial value" field keeps its masked default but offers the same
eye / eye-off reveal toggle the variable rows have, so a value typed in the
dialog can be checked before it is added to the draft. Masked-by-default is
correct for a shared-machine browser and is kept.
Evidence:
`apps/web/app/workspace/environment-editor.tsx` — the dialog's value `Input`
had a hard-coded `type="password"` with no sibling control, while
`VariableRow` renders a `Button` toggling `Eye` / `EyeOff` (aria-label
"Reveal <name>" / "Hide <name>") for the identical concept.
Status:
FIXED - the dialog's value field gains a `Reveal initial value` /
`Hide initial value` ghost toggle (`aria-pressed`, test id
`add-variable-reveal`) matching the rows; the field stays masked by default
and the value is stored exactly as typed either way. Verified in the browser
(toggle switches the input between dots and plain text and announces both
states) and by the add-variable e2e specs. Committed on main.

## UX-007 - Opening a project with no environments silently reverts to the projects list
Journey:
FIRST USE - create/connect first project (a Project linked without any Environment yet).
State:
Signed in, server trusted, a project with `environments: []` is open (the
catalog can report this: `dotrelay init` links the repository as a Project and
creates its first Environment separately, so the window in between is real and
the API's project catalog reports whatever Environments exist).
Severity:
HIGH
Observed:
Clicking the project card (which navigates to the environment view) or loading
a deep link with `view=environment` for such a project appears to do nothing:
the location resolver silently downgrades the view to the projects list and the
environment view renders nothing, so the user is left on the list with no
feedback and no next action. The one state that exists for this case — the
"No environments yet" line in the project card — is on the card they just
clicked.
User consequence:
A brand-new user whose first project has no environment yet (exactly the FIRST
USE moment after `dotrelay init` has linked the repo but before any
environment is published) clicks their project and the UI does not visibly
acknowledge the choice; there is no explanation of what an environment is or
what to do next. By the backlog's own order this is "no obvious next action" —
the most consequential category after a blocked user.
Expected:
Opening such a project keeps the environment view (the project header is shown)
and presents a single "No environments yet" state with the one real next
action (`dotrelay init`), mirroring the zero-teams and zero-projects states. A
deep link naming an environment of such a project recovers to this state with
the missing-resource notice adapted to the fact that the project has none at
all.
Evidence:
Reproduced in a real browser with a boundary whose catalog is a team plus one
project with `environments: []`: clicking the card left the projects list on
screen (verified in the DOM); `resolveWorkspaceLocation`
(`apps/web/lib/workspace-location.ts`) downgraded `view: "environment"` to
`"projects"` whenever `environmentId` was null, and the shell's environment
branch rendered `null` without a `selectedEnvironment`.
Status:
FIXED - `resolveWorkspaceLocation` now only drops the environment view when
there is no Project (a dropped Project still goes to the projects list, as
before); a valid Project with no Environments keeps the environment view. The
shell renders a "No environments yet" state (test id `no-environments-empty`)
with the `dotrelay init` next action, and the missing-environment alert copy
is adapted when the project has no environments at all so it cannot
contradict the card. Verified in the browser (card click and deep link both
land on the project's no-environments state with `view=environment` in the
URL) and by `apps/web/e2e/workspace-no-environments.spec.ts` plus the
`resolveWorkspaceLocation` unit tests. Committed on main.

## UX-008 - Signed-out state on a real deployment dead-ends on "No teams yet"
Journey:
FAILURE STATES - Authentication expiry; also FIRST USE - First sign in (a
returning user whose session expired).
State:
A real (non-fixture) deployment where the session expires - or was never
established - while the workspace is open or on a deep link: the boundary
relay stays online (it is served by the web app itself) but the API's
`authentication_required` shape comes back, so the catalog is empty
(`{ teams: [], projects: [] }`) and `session.active` is false.
Severity:
HIGH
Observed:
In a real deployment the signed-out projects view rendered the signed-in
"No teams yet" state - "Run this in a GitHub repository to create your
first Team, Project, and Environment: dotrelay init" - because the zero-
teams branch only tests `teams.length === 0` and never the session. A
signed-out deep link to a formerly-open project additionally stacked a
"That project is no longer available" missing-resource alert on top, which
is a false diagnosis: the project is available, the user is just signed
out. The only sign-in affordance was a static "Sign in required" line in
the sidebar with no button.
User consequence:
The one state a blocked user hits after their OAuth session expires - the
most consequential moment in the product (a team member suddenly loses
access to their team's secret-management UI) - is told to run `dotrelay
init` in a repository, which a signed-out user cannot do, and offers no
working sign-in action in the main content. By the backlog's own order
this is a blocked user: no obvious next action, and the shown next action
is wrong. The gap is invisible in the development fixture because the
fixture session never expires and always carries a populated catalog.
Expected:
When the verified boundary reports an online connection with an inactive
session, the projects view presents the sign-in state (the same state the
editor and sign-in page use) with a working link to `/sign-in`, and the
missing-resource alerts are suppressed because their premise - a signed-in
user whose resource disappeared - is false.
Evidence:
Reproduced in a real browser against the running app by intercepting the
boundary with the relay's signed-out shape (online, empty catalog,
`session.active: false`): a fresh load rendered "No teams yet ... dotrelay
init" and a deep link added "That project is no longer available". The
code path: the shell's projects view branched on `teams.length === 0`
alone (no session check), and the missing-resource alert render did not
gate on `sessionActive` either.
Status:
FIXED - the projects view now checks the session first: an online,
signed-out user sees the "Sign in" state (test id `sign-in-required`)
with a link to `/sign-in` instead of any signed-in empty state, and the
missing-resource alerts only render while a session is active, so an
expired session can no longer be misdiagnosed as a deleted resource.
Verified in the browser (fresh load, signed-out deep link, and an in-
flight expiry while an environment was open) and by the permanent
`apps/web/e2e/workspace-signed-out.spec.ts`; the signed-in zero-teams
spec still passes unchanged. Committed on main.

## UX-009 - Team view promises member management it does not offer
Journey:
TEAM USE - Change permissions, Remove teammate, Leave team where supported.
State:
The Team view of any signed-in user, at any role, desktop or mobile.
Severity:
HIGH (misleading stated capability, and it is the only way an owner can
repair a wrong invitation or remove a departed member).
Observed:
The Members card is a read-only table (User | Role | Status) whose only
action is "Invite member". No role - not even Owner, whom the view
discloses can "manage team members, projects, and environments"
(`roleDisclosure` in workspace-shell.tsx) - can remove a Member, change a
Member's role, or leave the team. `docs/administration.md` promises
"Remove a Member: Owner yes, Admin yes" and "Change Member/Admin/owner
roles: Owner yes", and the API exposes no such operations:
`membership-routes.ts` registers only resolve / create-invitation /
list-invitations / list-memberships / my-invitations / accept, and the
whole API has no PUT, DELETE, or PATCH route.
User consequence:
An owner who invited the wrong GitHub account, or whose teammate left the
company, has no path in the product to fix it; the UI states that owners
manage team members but offers only an add. Durable `REMOVED` records can
never be created.
Expected:
Either the product exposes remove / role-change / leave operations (API +
UI, per the `docs/administration.md` policy matrix), or the role
disclosure and the docs say team membership management is not available
in the web UI - the UI cannot promise management it cannot perform.
Evidence:
Browser walks (desktop and mobile): the members card's only control is
"Invite member"; no remove / dismiss / leave control exists anywhere in
the app; a Member's Invite button is correctly disabled. The API route
registration was checked directly: no member-mutation endpoint exists, so
no client could offer these operations.
Status:
FIXED - the Team view now performs the member management its disclosure
promises, and the API exposes it: POST
`/api/v1/teams/:teamId/memberships/:membershipId/role` (Owners only) and
POST `.../remove` (Owners and Admins, members only), both with an
Idempotency-Key like the invitation routes. The Members card gains an
Actions column: an Owner sees a role select and a "Remove member" button on
every active Member row that is not their own; an Admin sees the remove
button on plain Member rows only; a Member sees no controls, and no one
ever sees controls on their own row or on a removed row. The service keeps
a Team's last active owner in place (the database trigger) and the UI
reports the refusal as "This team needs at least one active owner."
Verified by `apps/api/src/membership-routes.test.ts` (role change,
removal, replays, the last-owner guard, and the Owner/Admin/Member
authorisation matrix) and by
`apps/web/e2e/workspace-team-management.spec.ts` (owner, admin, and member
views). Leaving a team is not a product capability (the policy matrix has
no such operation), so it stays unimplemented. Committed on main. See
DECISIONS.md (D-003).

## UX-010 - Browser device setup collapses every server failure into "The server rejected this browser."
Journey:
FIRST USE - Devices area, "Set up browser" (first-run Device enrollment).
State:
Any Server Profile; reproduced against the fixture deployment (API origin
returns a non-protocol response for `/api/v1/devices/bootstrap`) and pinned
against real problem codes by interception.
Severity:
HIGH (first-use critical path: no cause, no next action)
Observed:
`apps/web/lib/device-provisioning.ts` handled only `authentication_required`
and `state_conflict`; every other problem code from the
`devices/bootstrap` route — `service_unavailable`, `rate_limited`,
`device_not_active`, `unsupported_crypto_runtime`/`_suite`/`_api_version`,
`invalid_request`, `invalid_crypto_object`, `payload_too_large` — rendered
one opaque "The server rejected this browser." with no cause and no action.
A network-level failure (server down mid-setup) leaked the raw browser text
("Failed to fetch") into the message. The sibling stale-epoch repair flow in
the same file already maps its codes (`device_not_active`, `stale_epoch`)
and the team administration module maps its codes via `problemMessage`, so
the provisioning path was the lone straggler.
Expected:
Each failure the server can return names the situation and the next action,
matching the vocabulary the CLI already uses; a network failure says the
server was unreachable; anything unexpected falls back to a neutral retry
message that never dumps a raw code.
Status:
FIXED - `apps/web/lib/device-provisioning.ts` now maps the full code set the
bootstrap route can return (signed out, conflict, server down, rate-limited,
device revoked, incompatible API/cryptography, invalid request, unknown) to
actionable copy, wraps the bootstrap fetch so a network failure reports
"We couldn't reach the server." (same wording as `team-administration.ts`),
and shows raw text only for intentional messages. Verified by
`apps/web/lib/device-provisioning.test.ts` (code-to-copy mapping) and
`apps/web/e2e/workspace-enrollment-failures.spec.ts` (seven real-browser
scenarios: aborted request, 503/429/409/400 codes, an unknown code that
must not be dumped, and the pinned `state_conflict` line); full e2e suite
126/126. Committed on main.

## UX-011 - `device revoke-wrapper` asks for an identifier no user surface ever shows
Journey:
RECOVERY - CLI `dotrelay device revoke-wrapper --wrapper-id <id>`.
State:
Any account with an Account Master Key; reproduced on a real deployment.
Severity:
MEDIUM (recovery command unusable as documented)
Observed:
The API revoke route (`apps/api/src/device-routes.ts`, POST
`/api/v1/account-keys/wrappers/revoke`) parses `--wrapper-id` as a full
16-byte hex value. But the CLI only ever prints the abbreviated form
(12 hex chars, `abbreviateId` in `apps/cli/src/index.ts`), `dotrelay
status` does not list wrappers, and no CLI command or web surface (the
Recovery area manages named methods, not ids) shows a full wrapper id.
The help text claims the id comes "from dotrelay status or a previous
wrapper listing" — neither source exists.
Expected:
Either a listing surface that shows full wrapper ids (`dotrelay status`
or a `device wrappers` command backed by the existing
`GET /api/v1/account-keys/wrappers` endpoint) or the revoke command
accepts the abbreviated id; help text must name a source that exists.
Status:
FIXED - `dotrelay device revoke-wrapper` without `--wrapper-id` now lists
this account's active wrappers (via the existing
GET /api/v1/account-keys/wrappers) and you choose one; `--no-input` still
requires `--wrapper-id` (args validation mirrors the device transfer
contract). The list offers only wrappers whose revocation can succeed
under ADR 0009 (at least one Recovery Code wrapper and one wrapper of any
kind must remain), and with nothing revocable the command refuses with
that rule named. The card prints the full wrapper id wherever one is
produced (wrapper creation and this command's result), and the help text
now names sources that exist instead of "dotrelay status or a previous
wrapper listing". Verified by `apps/cli/src/args.test.ts` (bare invocation
parses, --no-input requires the flag) and `apps/cli/src/workflow.test.ts`
(picker lists full ids + types and revokes the chosen one, the last
Recovery Code wrapper is never offered, --no-input contract, nothing-
revocable refusal); full CLI suite 379/379; live binary: new help text,
exit 2 with the new usage line under --no-input. Live picker against a
real account is environment-blocked (GitHub sign-in requires a human).
Committed on main.
## UX-012 - Device approval copy says "this machine" when the CLI is on another host
Journey:
AUTHORIZATION - CLI `dotrelay setup` on a remote/SSH host with `--no-open`;
the user approves from a laptop browser at `/device?user_code=…`.
State:
Reproduced: the approval page shows "The CLI on this machine is asking to
sign in" while the machine whose browser the user holds is not the machine
running the CLI.
Severity:
LOW (copy; the flow still works)
Expected:
Copy that is true for both cases, e.g. "A DotRelay CLI is asking to sign
in" or naming the CLI's host when known.
Status:
FIXED - the approval page no longer claims the CLI is on this machine:
"A DotRelay CLI is asking to sign in. Check that the code matches the one
in its terminal" is true whether the CLI runs locally or over SSH with
--no-open, and the page metadata description matches. Pinned by the
existing device approval e2e in `apps/web/e2e/workspace.spec.ts`. Committed
on main.
## UX-013 - Duplicate `user:email` scope in the GitHub sign-in request
Journey:
SIGN IN - GitHub OAuth handshake.
State:
Any deployment with GitHub sign-in enabled; observed in the real OAuth
redirect (scope `read:user+user:email+user:email+repo`).
Severity:
LOW (cosmetic; GitHub de-duplicates, no functional effect)
Observed:
`apps/api/src/auth.ts` requests `["user:email", "repo"]` and the provider
defaults add `read:user` + `user:email` again, so the authorization URL
lists `user:email` twice.
Expected:
The scope list de-duplicated at the source so the consent screen and logs
show each scope once.
Status:
FIXED - the configured scope is now just `repo`; the provider's own
defaults (`read:user`, `user:email`) are no longer repeated in the
config, so the consent screen and logs show each scope once. Effective
permissions unchanged. Verified live against the running API:
`POST /api/auth/sign-in/social` now returns an authorize URL with
`scope=read:user user:email repo` (no duplicate). Committed on main.
## UX-014 - `env use` with no session points at project linking instead of signing in
Journey:
FIRST USE - `dotrelay env use <environment>` before any `dotrelay login`.
State:
Reproduced on a real deployment (clean CLI config, API up).
Severity:
LOW (wrong next-action; the command still exits non-zero)
Observed:
The remediation text suggests linking a project, but the actual blocker is
the missing session; the user has to discover `dotrelay login` themselves.
Expected:
When no session exists, the remediation says to run `dotrelay login` first.
Status:
FIXED - session precheck before the project-link demand in both surfaces
(`env use` dispatch and `loadWorkflowSession` label resolution); missing
session now exits 6 `authentication_required` with "login is required for
this Server Profile", while an existing session still gets the project-link
invocation error. Covered by three workflow tests; live binary proof on a
clean config (exit 6, no project-link mention).

## UX-015 - Pending-grants gate names a remediation that cannot work
Journey:
WORKSPACE - opening a protected environment whose browser Device has no
epoch grant (`grantsReady: false`).
State:
Any account where the browser enrolled but has no project grant yet;
reproduced from the setup-gate state machine
(`nextSetupAction` `pending-grants`).
Severity:
MEDIUM (half the remediation is false and the transfer path is invisible)
Observed:
The gate body read "Open the Recovery area to unlock the account with your
recovery code, or run `dotrelay pull` on this machine, to give this browser
the project's keys." But `dotrelay pull` only decrypts values into a worktree
with the CLI Device's own keys (grants are counted per
`recipientDeviceId`), so it can never give the browser keys; and the real
second path - accepting an Account Key Transfer in Recovery (the UI's
"From another device" method with its Transfer ID input, fed by
`dotrelay device transfer`) - was not mentioned at all.
Expected:
The body names only paths that give THIS browser keys: any Recovery unlock
method, or accepting a Transfer created by `dotrelay device transfer`.
Status:
FIXED - body rewritten to the Recovery + Transfer paths; unit test pins
`dotrelay device transfer`, Recovery area, and the absence of
`dotrelay pull`/`on this machine`.

## UX-016 - Setup copy claims the CLI runs "on this machine"
Journey:
WORKSPACE - setup gates and the CLI hand-off prompts.
State:
Browser setup surfaces that suggest the CLI as an alternative
(`environment-workflow.ts` crypto-unavailable/enroll-device,
`workspace-shell.tsx` and `environment-editor.tsx` "Prefer the CLI?").
Severity:
LOW (P3 copy; prescriptive language can mislead in the remote-CLI flow)
Observed:
Several surfaces say "the CLI on this machine" / "It sets up the CLI on
this machine" when the CLI may run elsewhere (--no-open/remote approval is
a first-class flow; the same co-location claim was fixed on the device
approval page as UX-012).
Expected:
Location-agnostic wording wherever the copy is not strictly describing
where the user would run a copied command.
Status:
FIXED - the five false co-location claims now say "the CLI is a separate
device" / "sets up the CLI, not this browser" / "or the CLI"; browser-key
storage copy ("Keys stay on this machine") kept because it is true.
Unit tests pin the absence of "CLI on this machine" in both setup-gate
bodies; the two workspace e2e surfaces that show the CLI hand-off pin
`getByText("CLI on this machine")` count 0.

## UX-017 - Recovery mutations can surface the raw transport message
Journey:
RECOVERY - adding a password/passkey, setting up or rotating a recovery
code, or staging a transfer when the request fails.
State:
Any non-`state_conflict` rejection (`authentication_required` on an
expired session, rate limits, contract errors) or a failed fetch, during
one of those five mutations.
Severity:
LOW-MEDIUM (user-visible internal jargon; the operation's own fallback
copy exists but is unreachable)
Observed:
`jsonPost`/`fetchJson` throw `AccountKeyRequestError` whose message is
always "The server rejected the request.", and five recovery catches
(`setupAccountRecovery`, `rotateRecoveryCode`, `addEncryptionPassword`,
`addPasskeyPrf`, `sendAccountKeyTransfer`) pass `error.message` through
whenever it is non-empty - which it always is - so the per-operation
fallbacks ("The password wasn't added. Try again." etc.) are dead code
and a failed fetch leaks the browser's "Failed to fetch" the same way.
Expected:
Transport-only failures (server rejections, failed fetches) show the
operation's written fallback; human-authored messages (`UNLOCK_FAILURE`,
`PasskeyPrfError`) still pass through.
Status:
FIXED - shared `recoveryErrorMessage` helper now backs all five catches:
server rejections (`AccountKeyRequestError`) and failed fetches
(`TypeError`) show the operation's written fallback; human-authored
messages still pass through. Red-green proven: the new e2e observed
"Recovery needs attention The server rejected the request." before the
fix and the written fallback after; four unit tests pin the helper.
Full suite 127/127, `bun run check` green.

## UX-018 - `project rotate` asks for confirmation before checking login
Journey:
FIRST USE / AUTOMATION - `dotrelay project rotate` without a session or
enrolled Device.
State:
Server Profile selected, no session (or an expired one) and no Device
enrolled; interactive terminal or not.
Severity:
MEDIUM (false first error; on a headless machine the reported problem is
the terminal, not the missing login)
Observed:
`rotateProjectEpoch` called `confirmSilent` before `syncWorkflow`, so the
destructive prompt came before any session/Device check. With a session
but no Device, `project rotate --json` on a non-TTY failed with exit 2
"the terminal could not be read, so the interactive prompt went
unanswered", while `--no-input --force` on the same machine correctly
reported exit 6 `authentication_required` "login is required for this
Server Profile". On a TTY the user would confirm first and fail auth
after. Publication (`publish`) already syncs before confirming.
Expected:
Verify the session, Device, and project context before asking for the
destructive confirmation, so the real blocker is reported first.
Status:
FIXED - `syncWorkflow` now runs before `confirmSilent` in
`rotateProjectEpoch` (the `--no-input`/`--force` guard stays first).
Red-green proven: the new unit test fails on the old order (confirmation
asked) and passes on the new one; live binary on a sessioned,
device-less config now reports exit 6 `authentication_required` instead
of the exit 2 terminal error.

## UX-023 - `project link` offers repositories before checking enrollment
Journey:
FIRST USE - `dotrelay project link --team <id>` in a worktree with
several Git remotes, signed in but with no Device enrolled.
State:
Server Profile selected, session present, no Device enrolled, more than
one Git remote so the repository cannot be auto-picked.
Severity:
MEDIUM-HIGH (opaque exit 8 `unexpected_failure` "The command could not
complete." instead of the enrollment remedy)
Observed:
The dispatch selected the GitHub repository before creating the admin
client, so with several remotes the interactive picker rendered first.
On a headless machine the closed stdin made the picker fail with exit 8
`unexpected_failure`, hiding the real blocker. Protected commands
(`pull`, `history`, …) already verify the enrolled Device before
repository selection.
Expected:
Verify the enrolled Device before offering the repository picker, so a
missing enrollment is reported first.
Status:
FIXED - `createAdminClient` now runs before `selectGitHubRepository` in
the `project link` dispatch. Red-green proven: the new test (two
remotes, no Device) fails on the old order (picker prompted) and passes
on the new one; the live binary in a multi-remote worktree now reports
exit 6 `device_bundle_missing` with no picker rendered.

## UX-019 - Unreadable-terminal failures name no remedy; picker EOF is opaque
Journey:
AUTOMATION - any confirming command (`project rotate`, publication
reviews) or repository picker run without a terminal (closed stdin).
State:
Non-TTY stdin (CI, pipes, `< /dev/null`), interactive mode (no
`--no-input`).
Severity:
MEDIUM (dead-end `unexpected_failure` exit 8 for the picker; remedy-less
exit 2 for confirmations)
Observed:
Two gaps. First, `terminalConfirm` reported "the terminal could not be
read, so the interactive prompt went unanswered" with no next action,
while the reverse direction (`--no-input` set) does say "remove
--no-input to answer the prompt". Second, `selectOption` let
`readTerminalLine`'s plain `Error("terminal input closed")` escape, so
`diagnosticForError` masked it as exit 8 `unexpected_failure` "The
command could not complete." - observed live when `project link` in a
multi-remote worktree rendered its picker before checking enrollment.
Expected:
Both paths report the same fixed diagnostic naming the two ways out:
run in an interactive terminal, or re-run with `--no-input`.
Status:
FIXED - shared `UNREADABLE_TERMINAL_MESSAGE` in `ui.ts` now backs
`terminalConfirm` and the `selectOption` line-input path (closed stdin
maps to it instead of escaping as a plain Error). `ask()` is
deliberately unchanged: free-text/secret prompts are answered with
`--*-file` flags or piped stdin, not `--no-input`, so the generic
automation hint would mislead there. Red-green proven for the picker
mapping; `bun test apps/cli/src/ui.test.ts` 27/27.

## UX-020 - Unreachable-server diagnostics do not name the origin
Journey:
FIRST USE / AUTOMATION - `dotrelay login` or `profile add` against an
unreachable Server Profile, with several profiles saved.
State:
Origin unreachable (server down, wrong host). `--json` or human output.
Severity:
LOW-MEDIUM (retryable error names an internal endpoint, not the server
that failed)
Observed:
`login --json` reported "could not reach the device authorization
endpoint after 3 attempts" and `profile add` reported "could not reach
the Server Profile capabilities endpoint after 2 attempts" - neither
names the origin, and the JSON diagnostic carries no origin field, so
with several Server Profiles the operator cannot tell which server
failed from the diagnostic alone.
Expected:
Name the origin that could not be reached.
Status:
FIXED - both subjects now include the attempted origin ("the device
authorization endpoint at <origin>", "the Server Profile capabilities
endpoint at <origin>"; the loopback-fallback path names the fallback
origin it actually attempted). Unit pins updated and the device-auth
test now asserts the detail; live binary against a dead origin reports
both details with the origin. `bun test` on `auth.test.ts` and
`profile.test.ts` 33/33.

## UX-021 - Unknown API routes return plain-text 404, not a problem document
Journey:
API CLIENT - any client requesting a path the API does not define
(typo, version drift, probe).
State:
Any unmatched route, e.g. `/api/v1/nonexistent`.
Severity:
LOW-MEDIUM (clients written against the problem-document contract get
unparseable `404 Not Found` text)
Observed:
Known routes answer failures as `application/problem+json` documents
(`type`, `title`, `status`, `code`, `detail`, `correlationId`), but
unmatched routes fell through to the framework default: `404 Not Found`
as `text/plain`. Every missing resource on a known route already maps
to `resource_not_found`; only the fallthrough differed.
Expected:
Unmatched routes answer with the same problem document shape.
Status:
FIXED - `app.notFound` now answers `resource_not_found` via the shared
`jsonProblem` helper (security gates still run first, so a disallowed
origin on an unknown route still gets `forbidden`). Red-green proven:
the new `index.test.ts` case fails on the old fallthrough and passes
with the handler.

## UX-022 - Same missing-Device state reports two different messages
Journey:
FIRST USE - any command needing an enrolled Device with none enrolled.
State:
Server Profile selected, session present or not, no Device enrolled.
Severity:
LOW (both messages name the remedy; the states they describe differ
only by command path)
Observed:
`pull`/`push`/`history`/`project link` reported "no Device is enrolled
for this Server Profile; run dotrelay login or dotrelay device enroll"
while `device transfer`, `device revoke-wrapper`, and the session-load
paths reported "no Device is enrolled on this installation; …" for the
same machine state. The enrollment record is per Server Profile
(`deviceMetadataPath(stateDirectory, pin)`), so the profile-scoped
wording is the precise one.
Expected:
One message for the state.
Status:
FIXED - the three `workflow-session.ts` / `workflow-core.ts`
(`loadAuthorizedDevice`) sites now use the "for this Server Profile"
wording. No test pinned the old wording; `workflow.test.ts` 88/88
green.

## UX-024 - Interactive rollback prompts name no remedy without a terminal
Journey:
AUTOMATION - bare `dotrelay rollback` (or without `--variable`) on an
enrolled machine with closed stdin.
State:
Authenticated and enrolled, non-TTY stdin, target Revision and/or
Variables omitted.
Severity:
LOW (exit 2 names the proximate cause but not the documented automation
flags)
Observed:
After syncing, the two free-text prompts ("Roll back to which
Revision?", "Variables to roll back?") failed on closed stdin with the
generic "the terminal could not be read, so the interactive prompt went
unanswered", naming neither the positional nor `--variable`. The generic
`--no-input` hint used for confirmations (UX-019) was deliberately not
applied to `ask()`: secrets must never be suggested onto the command
line - but rollback values are ids/ordinals/names, never secrets, so
command-specific remedies are safe here.
Expected:
Name the positional for the target and `--variable` for the Variables.
Status:
FIXED - shared `isUnreadableTerminalError` predicate in `ui.ts`
(matches both the base and remedied fixed messages); the two rollback
call sites remap it to errors naming the positional and `--variable`
(`ask()` itself unchanged, still the base fixed message). Red-green
proven at dispatch level with closed-stdin terminals.

## UX-025 - Devices table repeated this browser's OS in its summary line
Journey:
WEB - Devices view, the row for this browser after setting it up.
State:
Browser device enrolled with a client description (PR #247).
Severity:
LOW (correctness-neutral, but the row reads "Chrome 126 on Windows 10/11 ·
Windows 10/11" — the OS twice, in the most prominent row of the table)
Observed:
The render branch for the current device appended `· ${osName}` after
`clientSummary`. A browser's `clientSummary` already ends with its OS
("Chrome 126 on Windows 10/11", per `describeBrowserClient`), and in the
web app the current device is always this browser, so the append duplicated
the OS in every session. Proven live: the e2e enrolls the fixture browser
and the row rendered "Chrome 126 on Linux · Linux".
Expected:
The summary line is the client's own description, once.
Status:
FIXED - `workspace-shell.tsx` renders `clientSummary` alone (no `· osName`
append; peer rows never had one). The e2e pins the row to
"Chrome 126 on Linux" and asserts "· Linux" is absent; full e2e and
`check` green.

## UX-026 - Reloaded an enrolled browser was offered "Set up this browser" again
Journey:
WEB - reload /workspace and open Devices on a browser that is already set up.
State:
Browser Device enrolled (stored Device id and keys), fresh page load.
Severity:
MEDIUM (the Devices view denied the true state and offered a button that
creates a second Device on the server)
Observed:
`thisBrowserEnrolled` was derived only from in-session records (an open
Environment protocol session or the in-memory durable-device set, which is
empty after a reload until an Environment session loads). So on a cold load
the Devices view said "Set up this browser" and labeled this browser's row a
bare "Device" - even though the boundary, fetched with this browser's stored
Device id, reports the Device as active (the table even listed it with its
project access). Clicking the offered button runs provisioning, which has no
stored-Device guard, so it would enroll a duplicate Device for the same
browser. Proven live: the e2e enrolls the fixture browser, reloads, and saw
the setup prompt return.
Expected:
A fresh load keeps saying "This browser is set up" while the server confirms
the stored Device is active.
Status:
FIXED - `thisBrowserEnrolled` now also holds while `displayBoundary.device`
is active (the server's confirmation, true across reloads); the in-memory
records still cover the in-session gap after provisioning. E2E pins the
post-reload state: the "This browser is set up" card and the row named as
this browser's.

## UX-027 - `device transfer` picker offered peer Devices as bare UUIDs
Journey:
CLI - `dotrelay device transfer` without `--to`, several Devices enrolled.
State:
Authenticated and enrolled, interactive terminal.
Severity:
MEDIUM (the picker exists to prevent sending the account key to the wrong
Device; a bare UUID is the hardest label to match against the Devices table
in the web app, which shows the machine name)
Observed:
The boundary already carries each peer's name and client summary (PR #247),
and the web's transfer picker offers `name ?? clientSummary ?? id`, but the
CLI's `selectOption` list labeled every peer with its raw Device id - even
for a CLI that enrolled as "CatchOS".
Expected:
The same human labels the web picker shows: name, then client summary, then
the Device id for unlabeled Devices.
Status:
FIXED - `workflow-account-key.ts` labels each choice
`device.name ?? device.clientSummary ?? device.id`; `--to` still takes the
Device id for automation. The red-green test offers a named CLI peer and an
unlabeled one and pins the rendered picker.

## UX-028 - Team member load failure said "try again" with no way to
Journey:
WEB - Team view, the Team service's membership read fails (transient 5xx or
malformed reply) while the workspace connection stays online.
State:
Signed in, Team view open, membership read failed.
Severity:
LOW (dead end: the message instructs the user to try again, but nothing on
screen re-runs the load; the refetch only fires on team switch, session
change, or reconnect)
Observed:
The error card showed "Couldn't load team members" + "Something went wrong.
Try again." with no control. Recovery and the Environment editor both offer
explicit retry from their error states; the Team card was the one surface
whose remedy sentence had no remedy.
Expected:
The error offers the retry it describes.
Status:
FIXED - the error card's AlertAction carries a "Try again" button that
bumps the membership refetch trigger (the same `refreshTeamAdministration`
mutations use). E2E pins it: a 503 membership read shows the card with the
button; the service recovers, one click loads the record and the error goes
away.

## UX-029 - First sign-in drops the user on the project list
Journey:
FIRST USE - first sign in.
State:
Signed in, this browser not yet able to read values. Either no Teams, or a
Team exists but this browser has not confirmed the server and enrolled.
Severity:
HIGH (no ordered next action on the first screen a new user sees)
Observed:
OAuth returns to `/workspace`. An account with Teams sees the team name and
project cards immediately. An account with no Teams sees one sentence
pointing at `dotrelay init`, without install, `dotrelay setup`, server
trust, this browser's keys, or a recovery code. Those steps exist, on
Devices, Recovery, and the environment gate, and the user has to find them.
Expected:
The first screen is a short checklist. One step is current. It follows the
real order: confirm this server, create a Team from the CLI when none
exists, enroll this browser, and say what a missing recovery code costs.
The project list is the page once that browser can actually use it.
Status:
FIXED - the projects view renders the checklist from
`buildGettingStarted` until the server is trusted, this browser is
enrolled, and a Team exists. With a Team, "Continue to projects" dismisses
it for that user in this browser and "Show setup steps" brings it back.
No Team keeps the checklist on screen. Copy states that sign-in does not
create a Team or decrypt values, and that losing every device and the
recovery code leaves values unreadable. Verified by
`apps/web/lib/getting-started.test.ts` and
`apps/web/e2e/workspace-getting-started.spec.ts`. See DECISIONS.md (D-007).
