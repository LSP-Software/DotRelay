# DotRelay UX decisions

Decisions made during UX work, with the tradeoffs considered, so later
sessions don't relitigate them.

## D-001 - Sign out lives in the sidebar account menu (and the mobile sheet)
Date: 2026-09-18
Problem: Signed-in users had no sign-out control anywhere in the workspace UI
(UX-001).
Chosen:
- Desktop: the sidebar account block (avatar + name + "Signed in") is now a
  `DropdownMenu` trigger; the menu contains a single "Sign out" item.
- Mobile: the navigation sheet gains a "Sign out" button in its footer.
- Both call `POST {apiOrigin}/api/auth/sign-out` with `credentials: "include"`
  (the session cookie is scoped to the API origin), then navigate to
  `/sign-in` in a `finally` block so navigation happens even when the API is
  unreachable.
- The signed-out state keeps the old static block (no menu for a dead session).
Tradeoffs considered:
- A dedicated "Account" page or settings screen was rejected: it would add a
  route and a concept (account management) that doesn't exist in the product
  yet. The menu can grow (profile, API keys) without a page.
- Signing out from the profile switcher was rejected: the switcher switches
  DotRelay deployments (hosted vs self-hosted), not user accounts. Mixing the
  two would confuse "switch server" with "sign out".
- Clearing the browser's device keys / trust store on sign-out was rejected:
  that state is per-browser, not per-session. Closing the tab already leaves
  it intact, and reusing it means the next sign-in restores the same browser
  without re-enrolling (no re-trust, no re-keying). Signing out must not
  destroy credentials the user didn't ask to destroy.
Rejected options:
- A "Sign out" link in the landing page footer: only reachable after
  navigating away from the workspace; the natural place is where the account
  is shown.
- A confirm dialog: signing out is easily reversible (just sign back in), and
  a dialog adds friction for a one-step action.
Verification: `apps/web/e2e/workspace-account.spec.ts` covers the desktop menu
and the mobile sheet; both sign out and land on `/sign-in`.
