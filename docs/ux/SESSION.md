# DotRelay UX session log

Rolling log of audit sessions. Newest first.

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
