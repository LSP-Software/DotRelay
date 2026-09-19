# DotRelay UX journeys

The journeys audits walk end-to-end in the browser. Status per journey:
UNREVIEWED, AUDITING, ISSUES FOUND, NEEDS RECHECK, CLEAN-PASS-1, CLEAN-PASS-2.
A journey is CLEAN-PASS-N only after the Nth full browser pass found no new
issues.

## FIRST USE

- First sign in - UNREVIEWED (GitHub OAuth only reachable via a real account;
  the sign-in page itself was reviewed and reduced to a single button in
  #225)
- Zero teams - CLEAN-PASS-1 (UX-003 fixed: the dead empty "Choose a team"
  selector is gone; a signed-in, zero-Teams user sees one "No teams yet" action
  pointing at `dotrelay init`)
- Create first team - UNREVIEWED
- Zero projects - CLEAN-PASS-1 (a signed-in team with no projects shows the
  "No projects yet" card pointing at `dotrelay init`)
- Create/connect first project - CLEAN-PASS-1 (the state after a repository is
  linked but has no Environment yet was audited in the browser: opening such a
  project now shows "No environments yet" with `dotrelay init` instead of
  silently reverting to the projects list, UX-007)
- CLI setup - UNREVIEWED (the Devices view shows the copyable `dotrelay setup`
  command; e2e-covered)
- Publish first environment - UNREVIEWED
- First successful pull - UNREVIEWED
- First successful push/update - UNREVIEWED

## TEAM USE

- Invite teammate - UNREVIEWED (invitation flow is e2e-covered)
- Accept invitation - UNREVIEWED
- Teammate first login - UNREVIEWED
- Teammate first successful pull - UNREVIEWED
- Change permissions - UNREVIEWED
- Remove teammate - UNREVIEWED
- Leave team where supported - UNREVIEWED

## NORMAL USE

- Sign in - NEEDS RECHECK (covered by the audit below; re-verify on the
  hosted profile, which this environment cannot reach)
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
- Recovery - UNREVIEWED (Recovery nav item exists; flow not walked)
- Server trust - CLEAN-PASS-1 (trust gate + dialog is e2e-covered)

## FAILURE STATES

- Empty states - UNREVIEWED
- Loading - CLEAN-PASS-1 (UX-002 fixed: the initial loading state is now
  bounded - after 8s the shell shows "Still connecting to the server" with a
  "Try again" retry instead of an open-ended spinner; a healthy load settles
  in well under a second and never trips the stall)
- Network/API failure - UNREVIEWED (offline mode is e2e-covered)
- Invalid input - UNREVIEWED
- Authentication expiry - UNREVIEWED
- Forbidden access - UNREVIEWED
- Server unavailable - UNREVIEWED
- Deleted/missing resources - UNREVIEWED
- Stale state - UNREVIEWED (stale-epoch handling is e2e-covered)

## RESPONSIVE

- Mobile navigation - CLEAN-PASS-1 (sheet opens, includes team switcher,
  section links, and now Sign out)
- Onboarding (mobile) - UNREVIEWED
- Project workflow (mobile) - UNREVIEWED
- Variable management (mobile) - CLEAN-PASS-1 (small-viewport spec: dialog and
  keyboard behaviour at 200% zoom)
- Team workflow (mobile) - UNREVIEWED
- Menus/dialogs (mobile) - CLEAN-PASS-1
