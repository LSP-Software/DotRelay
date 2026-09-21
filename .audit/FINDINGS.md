# DotRelay Audit — Findings

Problems that do not justify immediate modification, or were fixed during the campaign.
Each entry: status, evidence, impact.

---

## F-001 (FIXED) Stale OpenAPI document in `packages/contracts/openapi.json`
- **Status:** FIXED_AND_VERIFIED (commit this campaign)
- **Symptom:** `bun run openapi:check` (part of `bun run check`) failed on a clean checkout:
  `packages/contracts/openapi.json` was missing the `last_owner_protection` problem code that
  `OPENAPI_DOCUMENT` in `packages/contracts/src/api.ts` exposes.
- **Root cause:** the file is generated from `OPENAPI_DOCUMENT` but there is no writer/refresh
  script in the repo — only the checker (`scripts/check-openapi.ts`). When `last_owner_protection`
  was added to the protocol (membership-routes last-owner protection), the checked-in document
  was not regenerated. CI/`verify` would have caught it, but the working tree on `main` was red.
- **Fix:** inserted the two missing lines (`last_owner_protection: 409` in `x-dotrelay.problemStatus`,
  and the code in the `Problem.code` enum) exactly where the source places them. Diff = 2 lines.
- **Verification:** `bun scripts/check-openapi.ts` passes; `biome ci` passes.
- **Regression protection:** `openapi:check` already exists and is wired into `check`/`verify`.
  The gap is process (no `openapi:generate` script). See D-003.

## F-002 (FINDING) No OpenAPI generation script — only a checker
- **Status:** FINDING (improvement opportunity)
- The repo ships `scripts/check-openapi.ts` which *validates* `openapi.json` against
  `OPENAPI_DOCUMENT`, but there is no `scripts/generate-openapi.ts` to *produce* it. Maintainers
  must hand-edit the JSON, which is exactly how F-001 happened. A one-line
  `bun run openapi:generate` that writes `JSON.stringify(OPENAPI_DOCUMENT)` would make the
  checked-in file trivially regenerable.
- **Recommendation:** add a `generate` script and a `precommit`/`verify` step that runs it.
  Low risk, high value. Not done in this campaign to keep the fix surgical.

## F-003 (FIXED) Archive/Restore UI was a no-op; no API endpoint existed
- **Status:** FIXED_AND_VERIFIED (this campaign)
- **Symptom (as found):** the web `LifecycleDialog` (`apps/web/app/workspace/workspace-shell.tsx`)
  only flipped local React state on confirm; that state is re-derived from the boundary
  catalog on the next refresh, so archive/restore silently reverted. No HTTP endpoint
  existed to change Project or Environment lifecycle, and there is no CLI command.
- **Evidence (as found):** the DB layer was complete and correct — `archiveProject/
  restoreProject/archiveEnvironment/restoreEnvironment`
  (`packages/database/src/persistence/repositories.ts:701/754/807/864`) with row locks,
  lifecycle guards, `requireTeamAction`, and audit facts — but was reachable only from
  `postgres.integration.test.ts`. `docs/web-application.md` described confirmed
  archive/restore operations, so a documented, user-visible feature did nothing.
- **Corrected root-cause note:** this finding originally claimed `restoreProject` lacks the
  documented fail-closed check and that the `projects_githubRepositoryId` index is
  non-unique. That is wrong: a conflicting *active* re-link is blocked fail-closed by the
  partial unique index `projects_active_team_repository_key`
  (`migrations/20260817100000_persistence/migration.sql:1065-1067`,
  `WHERE "lifecycle" = 'ACTIVE'`). Archiving the original releases the index slot, so a
  replacement re-link is allowed (see F-006); restoring the original while the replacement
  is active then fails the partial index and returns `state_conflict`.
- **Fix (this campaign):** added `POST /api/v1/projects/:projectId/lifecycle` and
  `POST /api/v1/environments/:environmentId/lifecycle` (`apps/api/src/administration-routes.ts`;
  actor via `requireProtocolActor`, the repository's `requireTeamAction` guard, idempotent by
  `Idempotency-Key`, and a body limit on the environment path). Wired the web
  `LifecycleDialog` confirm to persist through `changeProjectLifecycle`/
  `changeEnvironmentLifecycle` (`apps/web/lib/team-administration.ts`) so the workspace flips
  state only on the service's confirmed reply and surfaces a readable error on refusal
  instead of reverting. Updated the e2e spec to answer the lifecycle endpoint in place of the
  server and assert the workspace flips only once the service confirms.
- **Verification:** API unit tests (archive→restore round trip, `409 archived_resource` guard,
  `403` role, `401`/`400` auth/device, `400` bad action/key), the e2e suite (101 passed), and
  a live fail-closed sequence: archive original → re-link replacement (201) → restore original
  (409 `state_conflict`) → archive replacement → restore original (200).
- **Remaining gaps (not part of this fix):** no CLI lifecycle command (product gap); the
  membership-command re-execution variants are recorded in F-006 / D-009.

## F-004 (DEFECT) `?preview=` URL parameters are honored in live (non-fixture) deployments
- **Status:** OPEN (verified against source 2026-09-21)
- **Symptom:** `workspace-shell.tsx` reads `preview` from the URL unconditionally in the
  hydration effect (~:1244-1250). `protectedPreview` (:597-619, `displayBoundary`) forces
  `device.active`, `grantsReady: true`, `epochCurrent: true`, crypto available, and
  `profileTrusted` (:627-629). `?preview=admin` shows the role-preview selector
  (:2876-2894) and overrides `teamRoleFor` (:648-651) in live mode.
- **Docs contract:** `docs/web-application.md:52,100,117,187` describe the preview
  parameters as DEVELOPMENT-FIXTURE only (`DOTRELAY_WORKSPACE_FIXTURE=1`).
- **Impact:** On a real (non-fixture) deployment, any visitor with a valid session can append
  `?preview=` to the workspace URL and the UI asserts trusted/active-device state that the
  boundary does not support. No secret is disclosed (real values still require session +
  device + keys), but the UI state lies about readiness and role, and a role preview in
  production mis-represents permissions. Fix: gate all `preview` handling on the fixture
  switch.

## F-005 (FIXED) CLI identifier abbreviation renders `xxxxxxxx-undefined`
- **Status:** FIXED_AND_VERIFIED (this campaign)
- **Symptom:** Every abbreviated identifier the CLI displays — server profile id in the
  `profile add` trust frame ("Id 00000000-undefined"), project/environment ids in
  `dotrelay context` — rendered with a literal `undefined` fragment.
- **Root cause:** `abbreviateId` (`apps/cli/src/index.ts:300-306`) matched a two-group
  UUID regex but read `match[5]` instead of `match[2]`; `match[5]` is undefined, and the
  template string stringified it as `undefined`. The non-UUID fallback branch
  (`id.slice(0, 12)`) masked the bug for numeric GitHub repository ids, which is why the
  defect lived quietly on every human-rendered screen.
- **Fix:** one token, `match[5]` → `match[2]`. Verified live: `dotrelay profile add`
  trust frame shows `Id 00000000-0000`; `dotrelay context` shows `Project
  1a04be60-eba5`.
- **Regression:** `index.test.ts` "context card abbreviates identifiers without leaking
  undefined fragments" renders the real context card and asserts `verified
  (1311418611)`, `1a04be60-0000`, and the absence of `undefined`; proven red on the
  pre-fix code and green on the fix.

## F-006 (DEFECT, FIXED) Re-executed administration commands fail with `operation_conflict`
- **Status:** FIXED for the re-link/re-create surfaces and both lifecycle routes (verified live); the membership-command variants are a product question (D-009), not an un-fixed defect
- **Symptom:** After archiving the original project, re-linking the same GitHub repository
  (`POST /api/v1/projects`, `project.link`) returned `409 operation_conflict` and created nothing.
  The same failure pattern applies to any administration command that can legitimately be
  re-executed after its prior effect has been undone.
- **Root cause:** every JSON administration route computes `commandDigest =
  sha384(commandBytes)` where `commandBytes` is a *logical* description of the command that
  omits the per-execution `operationId` (`apps/api/src/administration-routes.ts`
  `team.create`/`project.link`/`environment.create`; `membership-routes.ts`
  `team.invite`/`membership.change_role`/`membership.remove`/`invitation.accept`). The
  `Operation` model enforces `@@unique([actorUserId, commandDigest])`
  (`packages/database/prisma/schema.prisma:794`). In `OperationRepository.begin`
  (`repositories.ts:330-358`), `operation.createMany(..., skipDuplicates: true)` therefore
  skips the insert for a new `operationId` whose `commandDigest` was already committed, the
  subsequent `findUnique({ id: operationId })` returns `null`, and `begin` throws
  `OperationConflictError` → `409 operation_conflict`. The protocol (device/publish) routes
  are immune because their canonical command bytes embed the operation id (the CBOR
  envelope); the JSON administration routes were the only surface with deterministic bytes.
- **Impact:** the documented F-003 fail-closed flow cannot complete —
  `postgres.integration.test.ts:714` proves the DB layer supports re-linking a repository
  after the original project is archived, but the API route 409s, so a conflicting active
  linkage can never be created to prove `restoreProject` fails closed. A team can also never
  re-create a project/environment of the same logical identity it previously had.
- **Fix (this campaign):** embed `operationId` in `commandBytes` for `project.link`,
  `environment.create`, and the new `projects/:id/lifecycle` + `environments/:id/lifecycle`
  routes, so each execution is a distinct command while a true replay (same `Idempotency-Key`)
  still deduplicates. Verified live (archive original → re-link → restore rejects → archive
  replacement → restore original, all as `postgres.integration.test.ts:707-746` specifies).
- **Open product question (not changed here):** `team.create`, `team.invite`,
  `membership.change_role`, `membership.remove`, `invitation.accept` use the same
  deterministic-bytes pattern. For these, a repeat of an *identical* command (e.g. re-inviting
  the same provider subject, or re-issuing the same role change after a revert) currently
  409s because the digest is already consumed. Whether that duplicate-prevention is intended
  or the same defect is a product decision — filed as a GitHub issue rather than changed, so
  the F-003 fix stays surgical. See DECISIONS.md D-009.
