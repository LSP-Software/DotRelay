# DotRelay UX session log

Rolling log of audit sessions. Newest first.

## 2026-09-19 - NORMAL USE variable editing: clean pass (edit, delete, pull, push, user-specific)

Skills: ux-audit (journey scoping + evidence), impeccable (empty-state /
state-handling review). The running app remained the source of truth
(Playwright DOM/ARIA walks; the cmux relay was down, so no screenshots were
surfaced to the model).

Scope:
- Walked the remaining NORMAL USE variable journeys end-to-end in a real
  browser (fixture user, production environment) and judged each against
  the backlog priority order. No new issues: every state the design can
  reach presents a correct next action, and the value model is consistent.

Verified:
- **Edit variable**: typing into `API_ORIGIN` shows the per-row "Draft
  change" badge and enables Save changes; the review dialog lists the change
  with the new value masked ("+ ••••••••") behind "Show values", which
  reveals the real value. Clearing the field to an empty string keeps the
  "Empty value" placeholder and is a distinct draft from "Not set"
  (placeholder "Not set"); reverting to the stored value clears the draft
  and re-disables Save changes (no phantom publish). The Unset value button
  is offered only for non-required variables that have a value - a required
  variable can never be unset, and an already-absent value needs none.
- **Delete variable**: deleting a variable tombstones its row - "This
  variable is marked for deletion." with an "Undo delete" button and a Draft
  change badge - and the value input and Unset button disappear. Undo
  restores the row and re-disables Save changes. In the review dialog a
  deletion is presented as "Will be deleted" (no value shown either way).
- **Push changes**: edit + review + Publish produced "Local preview saved as
  rev_0185"; the draft badge cleared, the published value survived the
  re-read, the history card advanced (rev_0185 Current), and Save changes
  re-disabled. The full publish protocol (sealed lanes, conflict handling)
  is e2e-covered in `workspace-protocol-publish.spec.ts`.
- **Pull changes**: reread after a publish restores the published value
  without clobbering the local draft; the reread protocol (stale-epoch
  detection, conflict lanes) is e2e-covered in
  `workspace-protocol-reread.spec.ts`.
- **User-specific variables**: ownership labels ("Shared value" /
  "User-defined value") render per row; a Member sees "Read-only" plus a
  card-level permissions note on values they neither own nor provided, and
  can still edit their user-defined value (draft badge, publish). Rollback
  of a user-provided shared value is restricted to the provider or an admin
  ("Only the person who provided it, or a team admin, can change it.").
  e2e-covered in `workspace-role-permissions.spec.ts`.

Remaining:
- The remaining UNREVIEWED journeys are first-use and failure-state ones
  (publish first environment, first pull/push, CLI setup, team flows, and
  the FAILURE STATES group). NORMAL USE is now fully covered.


## 2026-09-19 - Zero-environment project dead end (UX-007)

Skills: ux-audit (journey scoping + evidence), impeccable (empty-state
writing). The running app remained the source of truth (Playwright DOM/ARIA
walk; the cmux relay was down, so no screenshots were surfaced to the
model).

Scope:
- Continued the FIRST USE walk: zero teams (UX-003, fixed earlier) and
  zero projects were sound, so the next state was the one in between: a
  Project that exists but has no Environments. That state is real and
  reachable - `dotrelay init` links the repository as a Project and creates
  its first Environment as a separate operation (the API's
  `POST /api/v1/projects` and `POST /api/v1/projects/:id/environments` are
  distinct), and the live boundary reports whatever Environments exist, so
  the window between the two is a genuine FIRST USE moment.
- Reproduced in a real browser by intercepting the fixture boundary with a
  catalog of one team plus one project with `environments: []`: clicking
  the project card left the user on the projects list with no feedback.
  Mechanism: `resolveWorkspaceLocation` downgraded `view: "environment"`
  to `"projects"` whenever the resolved `environmentId` was null, and the
  shell's environment view branch rendered `null` without a
  `selectedEnvironment`. A deep link with `view=environment` did the same.

Changed:
- `apps/web/lib/workspace-location.ts`: the view downgrade now only applies
  when there is no Project (`projectId === null`); a valid Project with no
  Environments keeps the environment view. The resolver's doc comment was
  updated to match.
- `apps/web/lib/workspace-location.test.ts`: the old
  "drops the environment view when the project has no environments" test
  (which pinned the dead-end behaviour) was replaced by two tests: the
  environment view is kept for a project with no environments, and a
  deep link naming one of its nonexistent environments reports
  `missing: { kind: "environment" }` while still keeping the view.
- `apps/web/app/workspace/workspace-shell.tsx`:
  - The environment view now renders a "No environments yet" state (test
    id `no-environments-empty`) under the project header: one next action,
    `dotrelay init`, mirroring the zero-teams and zero-projects states.
  - The missing-environment alert copy is adapted when the selected
    project has no environments at all ("The project has no environments.
    Run this in the project's repository to create the first one:
    dotrelay init.") instead of claiming the user is "viewing the
    project's first available environment".
- `apps/web/e2e/workspace-no-environments.spec.ts` (new): a boundary with a
  zero-environment project, opened via the card click, shows the
  "No environments yet" state with `dotrelay init` and keeps
  `view=environment` in the URL; a deep link with `view=environment` lands
  on the same state; a project with environments is unaffected (tabs show,
  no empty state).
- `docs/ux/BACKLOG.md` (UX-007), `docs/ux/JOURNEYS.md` (zero projects,
  create/connect first project), and this file.

Verified:
- `bun run typecheck` green (6/6 tasks); `bun x biome check` clean on the
  touched files (the one `useExhaustiveDependencies` complaint in
  workspace-shell.tsx exists on the clean tree too - pre-existing).
- `bun test` on `lib/workspace-location.test.ts`: 16 pass.
- `bun run test:e2e`: 94 passed, 1 failed - the one failure
  (`workspace-small-viewport.spec.ts:182`) is the known pre-existing
  keyboard-visibility failure. One full-run of the history spec
  (`workspace-history.spec.ts:275`, the rebind-with-dirty-draft test)
  failed once in a full-suite run and passed both in isolation (12/12) and
  in a re-run of the full suite (94 passed), i.e. a flake, not a
  regression: that test's flow never leaves a project without
  environments.
- Browser walk (Playwright DOM/ARIA): the card click and the deep link
  both land on the project header plus "No environments yet ... dotrelay
  init"; the zero-projects state is unchanged.

Remaining:
- FIRST USE publish first environment / first pull / first push are still
  UNREVIEWED; then NORMAL USE edit/delete/pull/push variables, and the
  remaining FAILURE STATES journeys.


## 2026-09-19 - "Add variable" dialog: masked value with no reveal, fixed from a reset working tree (UX-006)

Skills: ux-audit (evidence + consistency), impeccable (affordance parity).
The running app remained the source of truth.

Scope:
- This session resumed from Git after a context reset. The working tree
  already held an in-progress version of this fix from the previous session:
  the "Add variable" dialog's "Initial value" field gained a reveal toggle,
  but the component had been converted to a named `function` (against the
  repo's arrow-function convention) and a stray over-indented `<p>` had been
  left in the setup card's CLI block. Both were repaired before committing.
- Finding: every value surface on the environment screen — each variable
  row, the diff and conflict views — offers an eye / eye-off reveal toggle,
  but the one place a value is *created* (the dialog's `type="password"`
  field) had none. A user types a secret blind and can only discover a
  mis-typed or mis-pasted value after publishing, on a device that consumes
  it. The reveal button's `aria-label` ("Reveal initial value") also
  collided with the field's label for `getByLabel("Initial value")`, which
  five existing e2e locators used; they now scope to the input by role.

Changed:
- `apps/web/app/workspace/environment-editor.tsx`:
  - `AddVariableDialog` (arrow function, per convention) keeps the value
    masked by default (correct for a shared machine); the field gains a
    ghost eye / eye-off toggle (`aria-pressed`, `aria-label` "Reveal
    initial value" / "Hide initial value", test id `add-variable-reveal`,
    `font-mono` input) that switches the input between `password` and
    `text`, mirroring the per-row reveal affordance so a value typed in the
    dialog can be checked before it is added to the draft. The value is
    stored exactly as typed whether or not it was revealed; the toggle
    state lives in the dialog and resets on remount.
- `apps/web/e2e/workspace-add-variable-reveal.spec.ts` (new, permanent):
  the dialog masks by default, the toggle switches to plain text with the
  value visible and back, and a value typed while masked is stored exactly
  as typed on the resulting row.
- `apps/web/e2e/workspace.spec.ts`, `workspace-small-viewport.spec.ts`,
  `workspace-variable-readability.spec.ts`: the five
  `getByLabel("Initial value")` locators now use
  `getByRole("textbox", { name: "Initial value" })` so the reveal button's
  aria-label no longer makes them resolve to two elements.
- `docs/ux/BACKLOG.md` (UX-006), `docs/ux/JOURNEYS.md` (Add variable), and
  this file.

Verified:
- `bun run typecheck` green (6/6 tasks); `bun x biome check` clean on the
  touched files.
- `bun run test:e2e` (full web suite): 91 passed, 1 failed. The one failure
  (`workspace-small-viewport.spec.ts:182`, "a focused field and the submit
  action stay visible over the keyboard") fails identically with this change
  stashed (verified against the clean tree in this session), so it is
  pre-existing and unrelated.
- Browser verification was DOM/ARIA-based (input `type`, `aria-pressed`,
  labels); no screenshots were surfaced to the model.

Remaining:
- FIRST USE: create first team / zero projects / first publish are the next
  priority per the audit brief; then NORMAL USE edit/delete/pull/push
  variables.


## 2026-09-19 - Bounded initial loading state with a retry (UX-002)

Skills: ux-audit (failure states + evidence), impeccable (copy). The running
app remained the source of truth; this session resumed from the audit state
reconstructed from Git, which left a corrupted half-applied version of this
fix in the working tree (a duplicated JSX fragment in the connection
branches) - the orphan was removed and the rest of the feature recovered.

Scope:
- The workspace shell shows "Loading workspace…" while the initial boundary
  fetch is in flight. If that fetch hangs (device provisioning stuck, a hung
  request, a server that accepts connections but never answers), the user was
  stranded on an open-ended spinner: no progress signal, no retry. UX-002 had
  recorded a stuck variant of this in the audit environment and was tracked
  as the next candidate.
- This session gave the finding a deterministic reproduction that does not
  depend on the audit environment: in a real browser, the first two
  `/api/workspace/boundary` fetches were intercepted and held pending
  (Playwright `page.route`, never fulfilled).

Changed:
- `apps/web/app/workspace/workspace-shell.tsx`:
  - A `LOADING_STALL_MS` (8s) threshold - generous: a healthy load of a
    profile resolves in well under a second (the boundary is a single
    no-store fetch, no bootstrap work).
  - While `connection === "loading"` and the boundary is unverified, a timer
    starts; if it fires, the loading state switches from the bare
    "Loading workspace…" line to "Still connecting to the server" with an
    explanation and a "Try again" button wired to the existing reconnect
    path (`requestRetry`).
  - A profile rebind restarts the stall episode (the flag resets and the
    effect is keyed on the profile), so a slow-but-healthy load of a newly
    selected profile is never reported as stalled.
  - The healthy path is unchanged: the moment the boundary verifies (or the
    fetch fails and the shell goes offline) the loading state leaves and the
    stall flag resets.
- `docs/ux/BACKLOG.md` (UX-002 closed), `docs/ux/JOURNEYS.md` (Loading →
  CLEAN-PASS-1), and this file.

Verified:
- `bun run typecheck` green; `bun x biome check` clean on the touched file.
- Real browser (Playwright against the running app, `DOTRELAY_WORKSPACE_FIXTURE=1`):
  - Hung fetch: reload with the first two boundary fetches held pending →
    the "Still connecting to the server" state with its "Try again" button
    appeared ~8s after reload; clicking it completed the next (unintercepted)
    fetch and the workspace settled to the signed-in view (team crumb,
    trust gate, project).
  - Healthy load: reload with no interception → the workspace settles within
    ~2s, well under the stall threshold; no false stalled state after 12s.
- `bun run test:e2e`: 90 passed, 1 failed. The one failure
  (`workspace-small-viewport.spec.ts:182`, "a focused field and the submit
  action stay visible over the keyboard") fails identically with this change
  stashed, i.e. it is pre-existing and unrelated (same failure recorded in
  the UX-003 and UX-004 sessions).

Environment notes (for the next session):
- The cmux browser relay was down in this session (`open` failed with
  "did not return a surface_id"); verification used Playwright directly,
  including a throwaway script (`page.route` hang) that was deleted after
  use. The OMP `browser` prelude attached to a manually launched
  `chromium-1234` CDP endpoint fine, but its page handle detaches across
  `page.reload()`, so multi-step reload scenarios need a standalone
  Playwright script instead.
- A long-lived browser tab that accumulates reloads can still enter a stuck
  "Loading workspace…" state in the fixture environment; the new stall
  state at least gives such a tab a retry button instead of an open-ended
  spinner.

Remaining:
- Every other journey in JOURNEYS.md is still UNREVIEWED; FIRST USE
  (create first team / zero projects / first publish) is the next priority
  per the audit brief, followed by NORMAL USE variable editing (add / edit /
  delete / pull / push).


## 2026-09-19 - Environment page: full-width "Archive environment" bar (UX-005)

Skills: ux-audit (evidence + severity), impeccable (visual hierarchy). The
running app remained the source of truth.

Scope:
- Re-walked the environment page (the core screen for managing variables) in a
  fresh profile: trusted the server, opened LSP-Software/DotRelay, production
  environment. At this width the header is a column (`flex-col` below the `lg`
  1024px breakpoint) and the default `align-items: stretch` stretched the
  `destructive`-variant "Archive environment" trigger into a full-width red
  bar between the project title and the environment tabs - the dominant element
  on the screen, above the Variables card.

Changed:
- `apps/web/app/workspace/workspace-shell.tsx`: the environment page header
  gained `items-start` for the sub-`lg` column (overridden by the existing
  `lg:items-end lg:justify-between` on desktop), so the archive/restore trigger
  keeps its natural width at every breakpoint. No change to the control's
  role, label, confirm dialog, or the desktop layout.
- `docs/ux/BACKLOG.md` (UX-005), `docs/ux/JOURNEYS.md` (Inspect variables),
  and this file.

Verified:
- `bun run typecheck` green; `bun run lint` clean.
- Playwright measurement (throwaway spec, deleted after): at an 800px viewport
  the button is 178px wide and left-aligned (a full-width bar would be ~700px
  of an 800px column); at 1440px it is 178px wide and right-aligned, i.e. the
  desktop layout is unchanged.
- `playwright test` on the workspace, publish, read, re-read, and
  role-permissions specs: 20 passed.

## 2026-09-19 - Environment setup card: browser vs CLI contradiction (UX-004)

Skills: ux-audit (journey + evidence), impeccable (hierarchy + copy). The
running app remained the source of truth.

Scope:
- Re-walked FIRST USE / NORMAL USE in a fresh browser profile (no stored trust
  or device). Trusted the server, opened the LSP-Software/DotRelay project
  environment. The environment is locked until this browser enrolls a device,
  so the "Set up this browser" card is shown.
- Found the contradiction: the card is titled "Set up this browser" and its
  button says "Set up browser", but the label above the visible command said
  "Use the CLI on this machine instead of this browser:" then showed
  `dotrelay setup …`. Three conflicting signals on the single most important
  first-use step. The shell's Devices view framed the CLI correctly ("Prefer
  the CLI? It sets up the CLI on this machine, not this browser."), so the two
  surfaces disagreed.

Changed:
- `apps/web/app/workspace/environment-editor.tsx`: the locked-environment card's
  CLI label now reads "Prefer the CLI? It sets up the CLI on this machine, not
  this browser." (matching the Devices view), so the command is an optional
  alternative for the same machine rather than something to do "instead of"
  this browser. The `#cli-setup-command` test id and the "Set up browser" button
  are unchanged; the CLI escape hatch still works.
- `docs/ux/BACKLOG.md` (UX-004) and this file.

Verified:
- `bun run typecheck` green; `bun run lint` clean (72 files).
- Browser: the card now reads "Set up this browser" → body → "Prefer the CLI?
  …not this browser." → `dotrelay setup` → "Set up browser"; no contradiction.
- `playwright test` on the environment, server-trust, and enrollment specs:
  22 passed.
- Full web e2e suite: 90 passed, 1 failed. The one failure
  (`workspace-small-viewport.spec.ts:182`, "a focused field and the submit
  action stay visible over the keyboard") reproduces identically with the
  change stashed, i.e. it is pre-existing and unrelated to this copy change.

Environment notes (for the next session):
- A fresh browser profile (the cmux relay profile) has no stored trust decision,
  so the workspace shows a "Trust this server" gate first; confirm it before
  walking the project environment. The gate is well designed (shows origin +
  identity, explains per-origin/per-identity scoping).
- Playwright's `webServer` owns port 3000; stop any hub-launched dev server
  before running `test:e2e` or it fails to start its own.

## 2026-09-18 - Zero-Teams empty state (UX-003)

Skills: ux-audit (journey scoping + evidence), impeccable (empty-state
writing and hierarchy). The running app remained the source of truth.

Scope:
- Walked the FIRST USE journey up to "zero teams". The web app has no
  team-creation surface, so the realistic zero-Teams state is a signed-in
  user who has not run the CLI yet. Reproduced it in e2e by intercepting
  `/api/workspace/boundary` to zero the fixture's `catalog` (keeping session,
  profile, device, environment intact so the client stays online).
- Found the dead state: a "Choose a team" heading plus an empty "Team"
  selector in the sidebar and the mobile sheet, contradicting the
  "No projects yet / run dotrelay init" card below.

Changed:
- `apps/web/app/workspace/workspace-shell.tsx`:
  - The zero-Teams projects view now renders a single "No teams yet" empty
    state pointing at `dotrelay init` (the one real next action), instead of
    the "Choose a team" heading + "No projects yet" card.
  - The sidebar team `<select>`, the mobile-sheet team `<select>`, and the
    header team crumb are hidden when there are no Teams, so no dead selector
    remains on desktop or mobile.
  - The one-or-more-Teams view is byte-for-byte unchanged.
- `apps/web/e2e/workspace-zero-teams.spec.ts` (new): a zero-Teams boundary
  shows no team selector and a "No teams yet" state with `dotrelay init`; a
  boundary with Teams keeps the selector.
- `docs/ux/BACKLOG.md` (UX-003), `docs/ux/DECISIONS.md` (D-002),
  `docs/ux/JOURNEYS.md`, and this file.

Verified:
- `bun x biome check` clean on the touched files; repo-wide lint baseline
  unchanged (184 errors, all pre-existing).
- `bun run typecheck` green (6/6 tasks).
- `bun run test:e2e`: 90 passed, 1 failed. The one failure
  (`workspace-small-viewport.spec.ts:182`) fails identically on a clean tree
  (verified by stashing this change) and is unrelated.

Decision recorded (D-002): no web "Create team" form. Teams and Projects are
created by the CLI (`dotrelay init`); the web UI manages variables of existing
Projects. A bare web-created Team (no repository) would not be useful, and a
second creation surface would diverge from the CLI.

## 2026-09-18 - Sign out for signed-in accounts (UX-001)

Skills: ux-audit (journey scoping), impeccable (menu component + copy).
Skills used for design/flow: both installed skills consulted; the app itself
remained the source of truth.

Scope:
- Walked the ACCOUNT / SECURITY journey in the browser: account block in the
  sidebar (desktop) and in the mobile navigation sheet.
- Confirmed the account block was a static, non-interactive display while
  signed in - no menu, no sign-out. The only exit was deleting cookies or
  closing the browser.

Changed:
- `apps/web/components/ui/dropdown-menu.tsx` (new): minimal Base UI Menu
  wrapper matching the repo's other `components/ui` wrappers (Portal,
  Positioner, Popup, Item), consistent with the existing shadcn-style
  primitives.
- `apps/web/app/workspace/workspace-shell.tsx`:
  - Signed-in account block is now a `DropdownMenu` trigger showing the
    account name and a "Signed in" status; the menu offers "Sign out".
  - The mobile navigation sheet gains a "Sign out" button at the bottom,
    visible only while a session is active.
  - `signOut` posts to `{apiOrigin}/api/auth/sign-out` with credentials
    (the session cookie is scoped to the API origin) and always navigates to
    `/sign-in` afterwards; browser device keys and trust decisions are left
    intact on purpose (see DECISIONS.md D-001).
- `apps/web/e2e/workspace-account.spec.ts` (new): verifies the desktop menu
  and the mobile sheet both sign out and land on `/sign-in`, and that no
  sign-out control exists before the menu is opened.
- `docs/ux/BACKLOG.md`, `docs/ux/DECISIONS.md`, `docs/ux/JOURNEYS.md`, and
  this file created from the intended-file layout in `docs/ux/README.md`.

Verified:
- `bun x biome check` clean on the touched files.
- `bun run typecheck` green (6/6 tasks).
- `bun run test:e2e`: 88 passed, 1 failed. The one failure
  (`workspace-small-viewport.spec.ts:182`, "focused field and the submit
  action stay visible over the keyboard") fails identically with the changes
  stashed, i.e. it is pre-existing and unrelated to this change.

Environment notes (for the next session):
- `bun run dev` at the repo root runs `turbo run dev --parallel`; the CLI
  package is named `@dotrelay/cli`, so `--filter=!dotrelay-cli` is invalid.
  To run only the web app, run `bun run dev --hostname localhost` from
  `apps/web`.
- With `DOTRELAY_WORKSPACE_FIXTURE=1` plus `NEXT_PUBLIC_DOTRELAY_WEB_PROFILE`
  set to `self-hosted`, the boundary API serves the fixture and the app
  renders signed-in as the fixture user. A long-lived browser tab that
  accumulates reloads can enter a stuck "Loading workspace..." + signed-out
  state; open a fresh tab to recover. Fresh tabs settle to signed-in.

Remaining:
- UX-002 (bounded loading state with a retry) is the next candidate; it
  first needs reproduction outside the fixture environment.
- Every other journey in JOURNEYS.md is still UNREVIEWED; FIRST USE is the
  next priority per the audit brief.
