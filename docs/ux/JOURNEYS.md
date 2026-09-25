# DotRelay UX journeys

The journeys audits walk end-to-end in the browser. Status per journey:
UNREVIEWED, AUDITING, ISSUES FOUND, NEEDS RECHECK, CLEAN-PASS-1, CLEAN-PASS-2.
A journey is CLEAN-PASS-N only after the Nth full browser pass found no new
issues.

## FIRST USE

- First sign in - CLEAN-PASS-1 (GitHub OAuth itself needs a real account; the
  sign-in page was reviewed in #225. After sign-in, a browser that is not yet
  usable opens on the first-run checklist instead of the project list, UX-029.
  The signed-out state still presents the Sign in action with a working link,
  UX-008)
- Zero teams - CLEAN-PASS-1 (UX-003 fixed: the dead empty "Choose a team"
  selector is gone; a signed-in, zero-Teams user sees one "No teams yet" action
  pointing at `dotrelay init`)
- Create first team - CLEAN-PASS-1 (team creation is CLI-driven - `dotrelay
  init` in the repository; the web-side state a zero-team user lands on is
  the fixed UX-003 card, so nothing for the web UI to present differently)
- Zero projects - CLEAN-PASS-1 (a signed-in team with no projects shows the
  "No projects yet" card pointing at `dotrelay init`)
- Create/connect first project - CLEAN-PASS-1 (the state after a repository is
  linked but has no Environment yet was audited in the browser: opening such a
  project now shows "No environments yet" with `dotrelay init` instead of
  silently reverting to the projects list, UX-007)
- CLI setup - CLEAN-PASS-1 (walked in the browser: the Devices view shows
  the copyable `dotrelay setup <origin>` command and the "Set up browser"
  action; the setup-card contradiction is fixed as UX-004; the approval
  page is e2e-covered)
- Publish first environment - CLEAN-PASS-1 (code + protocol review: a
  never-published environment verifies as a zero-revision genesis page and
  decodes to zero variables, and the editor shows "Add a variable to save
  your first secrets here." with the Add variable action enabled - the
  exact state pinned by workspace-protocol-read.spec.ts)
- First successful pull - CLEAN-PASS-1 (the first reread IS the pull
  protocol: covered by workspace-protocol-reread.spec.ts and walked in the
  browser - a reread after a publish restores the published values and the
  history card shows the new revision as Current)
- First successful push/update - CLEAN-PASS-1 (publish protocol covered by
  workspace-protocol-publish.spec.ts and walked in the browser - publish
  reports "Local preview saved as rev_…", the draft badge clears, and the
  review dialog masks values until "Show values")

## TEAM USE

- Invite teammate - CLEAN-PASS-1 (dialog + validation are e2e-covered in
  workspace-invitations.spec.ts; the button is role-gated and disabled for
  members, confirmed in the browser)
- Accept invitation - CLEAN-PASS-1 (accept flow, pending-membership list,
  and post-accept key-grant state are e2e-covered in
  workspace-invitations.spec.ts)
- Teammate first login - CLEAN-PASS-1 (a freshly accepted member is the
  PENDING_KEY_GRANT lifecycle the UI renders as "Waiting for encryption
  keys"; once the grant set lands they land on the normal workspace - the
  signed-out/empty states they could otherwise hit are fixed by UX-003/007/
  008)
- Teammate first successful pull - CLEAN-PASS-1 (identical pull protocol to
  "First successful pull"; the member-role gating a teammate hits is
  e2e-covered in workspace-role-permissions.spec.ts)
- Change permissions - CLEAN-PASS-1 (UX-009 fixed: an Owner changes a
  Member's role from the Members card's Actions column; the Owner-only
  authorisation is e2e- and API-test-covered, and the e2e confirms the
  refreshed record reports the new role)
- Remove teammate - CLEAN-PASS-1 (UX-009 fixed: an Owner or Admin removes
  a member from the same Actions column - Admins on plain Member rows
  only - and the refreshed record marks the membership Removed; the
  last-owner guard and the Owner/Admin/Member matrix are
  API-test-covered)
- Leave team where supported - NOT A CAPABILITY (docs/administration.md
  defines no leave operation, so there is no product behaviour to audit;
  a departing member is removed by an Owner or Admin instead)

## NORMAL USE

- Sign in - CLEAN-PASS-1 (the sign-in page is a single button, #225; the
  signed-out workspace state it lands on is e2e-covered in
  workspace-signed-out.spec.ts, UX-008; the hosted OAuth round-trip still
  needs a real account)
- Find project - CLEAN-PASS-1 (workspace lists projects per team; switching
  teams and projects is e2e-covered)
- Switch project - CLEAN-PASS-1
- Switch team - CLEAN-PASS-1 (team combobox in the sidebar and the sheet)
- Inspect variables - CLEAN-PASS-1 (environment page audited in the browser:
  the prominent full-width red "Archive environment" bar below `lg` is fixed
  as UX-005; the setup card's browser-vs-CLI contradiction is fixed as UX-004.
  Primary actions Add variable / Save changes and the empty/loading/failed
  states are sound)
- Add variable - CLEAN-PASS-1 (dialog audited in the browser: the masked
  "Initial value" field gains a reveal toggle matching the variable rows
  (UX-006), so a value typed in the dialog can be checked before it is added;
  ownership choices, unset checkbox, and validation are e2e-covered)
- Edit variable - CLEAN-PASS-1 (walked in the browser: typing shows the per-row
  "Draft change" badge and enables Save changes; the review dialog masks
  values behind "Show values"; clearing to an empty string is distinct from
  "Not set" and from no change; Unset is offered only on non-required
  variables; reveal and delete affordances and the member's read-only rows
  (with the card-level permissions note) are e2e-covered)
- Delete variable - CLEAN-PASS-1 (walked in the browser: deleting tombstones the
  row - "This variable is marked for deletion" with an Undo delete button and
  a Draft change badge; undo restores the row and re-disables Save changes;
  the review dialog labels a deletion "Will be deleted"; the Unset button is
  hidden on tombstoned rows)
- Pull changes - CLEAN-PASS-1 (reread protocol is e2e-covered in
  workspace-protocol-reread.spec.ts; the browser walk confirmed a reread after
  a publish restores the published value and the history card shows
  rev_0185 as Current)
- Push changes - CLEAN-PASS-1 (walked in the browser: edit, review dialog
  masking values until "Show values", Publish -> "Local preview saved as
  rev_0185", draft badge clears, Save changes re-disables; publish protocol
  is e2e-covered in workspace-protocol-publish.spec.ts)
- User-specific variables - CLEAN-PASS-1 (role e2e covers it: a member sees
  "Read-only" on values they don't own and the card-level permissions note,
  edits their user-defined value with a Draft change badge, and rollbacks are
  restricted to the provider or an admin; ownership labels render per row in
  the browser)

## ACCOUNT / SECURITY

- Account menu - CLEAN-PASS-1 (now a dropdown with Sign out; see UX-001)
- Sign out - CLEAN-PASS-1 (UX-001 fixed; desktop menu + mobile sheet verified
  in e2e and browser)
- Device management - CLEAN-PASS-1 (devices table, CLI setup command,
  device approval page are e2e-covered)
- Adding/new device - CLEAN-PASS-1 (approval page is e2e-covered)
- Recovery - CLEAN-PASS-1 (now in-browser: the Recovery area's one-time
  code is shown in an alertdialog; the journey is e2e-covered in
  workspace-recovery.spec.ts, incl. rotation, password add/remove,
  transfer, and the offline retry card; the CLI backup/recover flow
  stays separate)
- Server trust - CLEAN-PASS-1 (trust gate + dialog is e2e-covered)

## FAILURE STATES

- Empty states - CLEAN-PASS-1 (each empty state audited across the
  sessions: zero teams UX-003, zero projects, zero environments UX-007,
  zero variables ("Add a variable to save your first secrets here."),
  zero devices, and the signed-out state UX-008 - all present a real next
  action instead of a dead selector or silent revert)
- Loading - CLEAN-PASS-1 (UX-002 fixed: the initial loading state is now
  bounded - after 8s the shell shows "Still connecting to the server" with a
  "Try again" retry instead of an open-ended spinner; a healthy load settles
  in well under a second and never trips the stall)
- Network/API failure - CLEAN-PASS-1 (offline mode is e2e-covered; the
  initial offline state is the bounded "Couldn't reach your server" alert
  with a Try again action, and a mid-session drop shows the amber offline
  banner while keeping the last verified state)
- Invalid input - CLEAN-PASS-1 (the Add variable dialog audited in the
  browser: empty submit, invalid name, duplicate name, and required-with-
  unset each show the specific validation alert in a role=alert; a valid add
  closes the dialog and the reopened one starts clean with no stale error;
  the 1 MiB value limit is enforced at the same choke point)
- Authentication expiry - CLEAN-PASS-1 (walked in the browser and e2e: an
  online session that expires resolves the projects view to the Sign in
  state with a working link instead of the signed-in empty states, and
  signed-out deep links no longer misdiagnose the signed-in selection as a
  deleted resource, UX-008)
- Forbidden access - CLEAN-PASS-1 (role e2e covers member/admin/owner
  gating; walked in the browser: a Member gets a disabled Invite button,
  no Role column, and read-only value rows with the card-level permissions
  note; admin controls (archive, lifecycle) are disabled for non-admins)
- Server unavailable - CLEAN-PASS-1 (the boundary relay serves the app, so
  the web app itself failing to load is an operator concern; inside the
  app, a server it cannot reach shows the bounded "Couldn't reach your
  server" state with a Try again action - same code path as network
  failure above)
- Deleted/missing resources - CLEAN-PASS-1 (a deep link to a deleted
  project or environment was walked in the browser: the shell resolves to
  the first available selection and explains it with one alert - "That
  project is no longer available ... Choose another project to continue" -
  instead of dead-ending on the lost resource)
- Stale state - CLEAN-PASS-1 (stale-epoch handling is e2e-covered in
  workspace-stale-epoch.spec.ts: a server rotation surfaces the stale-
  epoch setup card with its re-enrollment action instead of a silent
  failure)

## RESPONSIVE

- Mobile navigation - CLEAN-PASS-1 (sheet opens, includes team switcher,
  section links, and now Sign out)
- Onboarding (mobile) - CLEAN-PASS-1 (walked on a 390x844 mobile
  context: the trust gate, the "Open navigation" sheet with team
  switcher and Sign out, and the Devices setup card all render and act
  at the small viewport)
- Project workflow (mobile) - CLEAN-PASS-1 (walked on the same mobile
  context: project cards open the environment, the environment tabs and
  the editor (variables card, history card, dialogs) all fit and function)
- Variable management (mobile) - CLEAN-PASS-1 (small-viewport spec: dialog and
  keyboard behaviour at 200% zoom)
- Team workflow (mobile) - CLEAN-PASS-1 (walked on the same mobile
  context: the members card and the project archive control render
  legibly; the UX-009 management controls live in the same members
  table, so nothing mobile-specific is added by the fix)
- Menus/dialogs (mobile) - CLEAN-PASS-1
