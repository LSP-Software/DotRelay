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
- Zero projects - UNREVIEWED
- Create/connect first project - UNREVIEWED
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
- Inspect variables - UNREVIEWED
- Add variable - UNREVIEWED (dialog is e2e-covered, incl. small viewports)
- Edit variable - UNREVIEWED
- Delete variable - UNREVIEWED
- Pull changes - UNREVIEWED
- Push changes - UNREVIEWED
- User-specific variables - UNREVIEWED

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
- Loading - NEEDS RECHECK (UX-002: long/stuck loading after reload in the
  audit environment; fresh tabs settle quickly)
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
