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

## D-002 - Zero-Teams state hides the selector and points at the CLI (no web team-creation)
Date: 2026-09-18
Problem: A signed-in user with zero Teams saw a dead empty "Choose a team"
selector and a misleading heading (UX-003).
Chosen:
- When `catalog.teams` is empty, the workspace removes every "choose a team"
  control (the sidebar team `<select>`, the mobile-sheet team `<select>`, and
  the header team crumb) and shows a single "No teams yet" empty state whose
  one action is to run `dotrelay init`.
- The normal (one-or-more-Teams) view is unchanged.
Why not a web "Create team" form:
- By DotRelay's product model, Teams and Projects are created by the CLI:
  `dotrelay init` "creates the missing Team, Project, and Environment" (CLI
  help). The web UI is the surface for managing the environment variables of
  existing Projects - it has no "create project" either; its empty state also
  says "run dotrelay init".
- The API does expose `POST /api/v1/teams`, but a bare Team (no Project, no
  repository link) is not a useful thing to create from the browser - the
  value of a Team is the projects inside it, and those require a repository.
  A web "create team" form would create a Team the user then still has to
  leave the browser to populate, splitting one workflow across two surfaces.
- Adding web team-creation would also make the web and CLI diverge as two
  sources of truth for Team creation.
Tradeoffs considered:
- A "Create team" dialog in the web UI (the API supports it). Rejected for the
  reasons above; revisit only if the product adds a browser project-creation
  flow that makes a bare web-created Team useful.
- Rewording the heading to "No teams" while keeping the empty selector.
  Rejected: the empty selector is still a dead control; the structural fix is
  to remove it, not to relabel it.
Verification: `apps/web/e2e/workspace-zero-teams.spec.ts` - a zero-Teams
boundary shows no team selector and a "No teams yet" state pointing at
`dotrelay init`; a boundary with Teams keeps the selector.

## D-003 - Member management is Owner/Admin API mutations; no self-leave

Context:
- UX-009 found the Team view promised member management (its disclosure
  says owners "manage team members") while the API exposed none of it:
  only resolve / create-invitation / list-invitations / list-memberships /
  my-invitations / accept.
- `docs/administration.md`'s policy matrix already promises it: "Remove a
  Member: Owner yes, Admin yes" and "Change Member/Admin/owner roles:
  Owner yes". The product decision behind UX-009 was to implement the
  documented operations rather than re-scope the docs down to invite-only.

Decision:
- Two new protocol routes under the Team, POST + Idempotency-Key (the
  convention every other Team mutation in this codebase uses - the API
  has zero PUT/DELETE/PATCH):
  - `POST /api/v1/teams/:teamId/memberships/:membershipId/role`
    `{"role": "OWNER" | "ADMIN" | "MEMBER"}` - Owners only.
  - `POST /api/v1/teams/:teamId/memberships/:membershipId/remove` `{}` -
    Owners and Admins (Admins on plain Member rows only).
- Both require a signed-in session AND an active browser Device
  (`requireProtocolActor`, like the invitation mutations) and reuse the
  existing `MembershipAdministrationRepository.changeRole` / `.remove`
  code paths: same authorisation (`managedRoleAction`), same idempotency
  (`OperationRepository.begin`), same audit (`MEMBERSHIP_ROLE_CHANGED` /
  `MEMBERSHIP_REMOVED`), and the database's last-owner trigger still
  applies, so a Team never loses its final active owner. A refusal
  surfaces as the new stable problem code `last_owner_protection` (409),
  not a generic conflict.
- The web Members card gains an Actions column mirroring the server's
  authorisation exactly: an Owner sees a role select plus "Remove member"
  on every active row that is not their own; an Admin sees only "Remove
  member", and only on plain Member rows; a Member sees nothing. No row -
  including the actor's own - ever offers controls over itself, and
  removed rows keep none.
- "Leave team" is NOT built: the policy matrix defines no such operation,
  so it is not a product capability and is recorded as such in
  JOURNEYS.md rather than shipped or documented as a feature.

Rejected:
- PUT/DELETE verbs. Rejected: the whole API is POST + Idempotency-Key;
  introducing a first PUT/DELETE would create a second, unreferenced
  convention for the same class of mutation.
- A "Leave team" self-serve. Rejected: it is absent from the documented
  policy, and shipping a capability the docs do not promise would invert
  the product's deliberate owners-manage-members model.

Verification: `apps/api/src/membership-routes.test.ts` (role change,
removal, replays, the last-owner guard, and the Owner/Admin/Member
authorisation matrix) and `apps/web/e2e/workspace-team-management.spec.ts`
(owner, admin, and member views of the Actions column, including the
own-row and removed-row cases).
