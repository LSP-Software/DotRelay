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
