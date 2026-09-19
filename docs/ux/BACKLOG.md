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
OPEN - needs reproduction with a real (non-fixture) boundary and a fresh
profile before changing the shell's loading logic. Tracked so the next audit
session starts from here instead of re-deriving it.

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
