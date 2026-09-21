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

## F-004 (FIXED) `?preview=` URL parameters are honored in live (non-fixture) deployments
- **Status:** FIXED_AND_VERIFIED (this campaign; live self-hosted browser probe 2026-09-21)
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
  production mis-represents permissions.
- **Fix (this campaign, commit a58055a):** the single URL-ingestion point now gates on the
  fixture switch — `const nextPreview = WORKSPACE_FIXTURE ? params.get("preview") : null`
  (`workspace-shell.tsx` ~:1315) — so in live deployments `?preview=…` is ignored and the
  real device boundary renders instead.
- **Verification (live, 2026-09-21):** on the self-hosted non-fixture deployment, the signed-in
  browser probed `/workspace?preview=protected` and `/workspace?preview=admin`: both rendered
  the real boundary (team "Audit Team" catalog, "Open a project…", `editorActive: false`),
  with no "Preview role" text and no `preview-role` select — the `preview` parameter had no
  effect, confirming the gate. No dedicated live-mode regression test is feasible: the gate
  is a build-time `NEXT_PUBLIC_*` constant, so the fixture e2e suite (102 specs) structurally
  cannot exercise the live branch; the fixture path it guards is the same code that now
  ignores `preview` in live mode, and the live branch is verified by the direct probe above.

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

## F-007 (FIXED) Self-hosted browser lifecycle archive/restore silently no-ops (no API origin inlined)
- **Status:** FIXED_AND_VERIFIED (this campaign; found and verified in a live self-hosted browser pass)
- **Symptom:** In a self-hosted deployment that declares no build-inlined API origin
  (no `NEXT_PUBLIC_DOTRELAY_API_ORIGIN` / `DOTRELAY_API_ORIGIN`), the workspace's
  "Archive/Restore environment" and "Archive/Restore project" buttons opened the confirm
  dialog and then did nothing — no HTTP request, no error, state unchanged. The environment
  stayed `ACTIVE` in the DB.
- **Root cause:** `workspace-shell.tsx` computes a shell-level
  `const apiOrigin = resolveApiOrigin()` (no fallback) for the membership/invitation
  surfaces, which are *intentionally* skipped when no origin is declared (the "Team data
  unavailable" alert). The two lifecycle handlers copied that bare `apiOrigin` and guarded
  `if (!apiOrigin || !target) return;`. But the sibling device-bootstrap and key-recovery
  handlers fall back to the *verified* Server Profile origin (`resolveApiOrigin() ??
  boundary.profile.origin`), so in the same browser device bootstrap succeeded while the
  lifecycle buttons bailed. `resolveApiOrigin()` reads `NEXT_PUBLIC_*` / build-inlined vars,
  none of which exist in a pure self-hosted client bundle, so it is `undefined` there.
- **Why the suites missed it:** the API unit tests always pass a defined `apiOrigin`, and the
  Playwright e2e runs in fixture mode which *does* set `NEXT_PUBLIC_DOTRELAY_API_ORIGIN` (so
  `resolveApiOrigin()` is defined and the request goes to the intercepted endpoint). Only a
  real live self-hosted browser — no inlined origin, real trusted profile — exposes the
  undefined value.
- **Fix:** in `persistEnvironmentLifecycle` / `persistProjectLifecycle`, resolve
  `const origin = apiOrigin ?? boundary.profile.origin;` and guard on `origin`, exactly as the
  device-bootstrap and recovery handlers do. The fallback is the same Server Profile origin the
  boundary already verified and the user just trusted, so it is not pointed at an unrelated
  server. The membership/invitation surfaces keep their documented "skip when no origin"
  behaviour.
- **Verification:** live self-hosted browser (user A, freshly bootstrapped browser device as
  actor): "Archive environment" → confirm → button flips to "Restore environment" (state
  persisted; two `ADMINISTRATION` operations committed, environment then `ARCHIVED`); "Restore
  environment" → confirm → editor back to the variables view, environment `ACTIVE`. No error
  alert at any step. A pre-fix click in the same browser produced no request and no state
  change (environment stayed `ACTIVE` in the DB), confirming the silent no-op.

## F-008 (FIXED) Web environment editor shows the wrong remediation for User-defined Value decode failures
- **Status:** FIXED_AND_VERIFIED (this campaign; found in the live self-hosted browser pass, fixed in code)
- **Symptom:** When this Device cannot decrypt the environment head, the web editor collapsed
  every `UnreadableLaneError` into one message: "Run dotrelay pull in the CLI on this
  machine to re-share the project's keys." That is correct only for Variable definitions
  and Shared Values (sealed to the Project epoch key, which `pull` re-wraps to peer
  devices). For User-defined Values it names a remedy that does not exist: they are
  sealed to the *publisher Device's* user-defined key, which `pull`'s re-share
  (`wrapEpochKeyToPeers`, `apps/cli/src/workflow.ts:634-682`) never re-wraps.
- **Root cause:** `environment-editor.tsx` matched `error instanceof UnreadableLaneError`
  without inspecting `laneKind`, while the CLI already distinguishes the two cases
  (`apps/cli/src/workflow.ts:2837-2839`: user-defined → "run dotrelay device enroll/recover,
  then re-publish the affected Values"; otherwise → "run dotrelay pull after an owner or
  admin re-shares").
- **Fix:** branch on `error.laneKind === "USER_DEFINED_VALUE"` and show the re-publish /
  device-recover remedy for User-defined Values; keep the pull-based Project-keys remedy for
  definitions and Shared Values, phrased as an owner/admin action (the key-holder may be
  another user's Device).
- **Verification:** code-reviewed against the two-remedy model in `workflow.ts` and the
  `UnreadableLaneError.laneKind` contract (`packages/client/src/sync/publication.ts:172-207`);
  `bun run check` and the e2e suite pass; the e2e decrypt-failure specs assert only the
  `crypto-unavailable` heading and no test pinned the old flat string. The live browser pass
  that surfaced this finding actually failed on *definition* lanes (the browser lacked the
  real Project epoch key — see F-009), so the pull-remedy branch rendered there; the
  user-defined branch is exercised by the two owner-A User-defined Value lanes at the head,
  which stay sealed to the CLI publisher Device's per-device key for the browser Device.
  After the F-009 fix was deployed and the browser was re-enrolled and re-shared the real
  epoch key (documented in F-009 below), the live browser rendered this user-defined-branch
  alert verbatim for the two owner-A lanes — live proof of the branch, not just code review.

## F-009 (FIXED) Newly enrolling Device self-mints a spurious Project epoch grant that can never decrypt pre-existing content and permanently blocks peer re-share
- **Status:** FIXED_AND_VERIFIED (this campaign; live self-hosted browser re-enrollment pass after the fix)
- **Symptom:** A freshly enrolled browser Device that already has a *different* Device
  (e.g. a CLI) holding the Project's real epoch key cannot read the environment's
  definitions or Shared Values, while the boundary reports `grantsReady: true` so no
  repair prompt is offered. The documented remediation — an owner/admin running
  `dotrelay pull` to re-share the key — is a proven no-op for that Device.
- **Root cause:** enrollment self-mints a `CURRENT_PROJECT_EPOCH` grant containing a
  *fresh random* key (`grant-bootstrap.ts:48-50`, `plaintextKey ?? getRandomValues(32)`)
  whenever no *presented* Device exists (`workspace-shell.tsx` enrollment gate checks only
  `boundary.device`, which is absent for a fresh browser — it never consults
  `boundary.peerDevices`, which reports the CLI Device with `hasEpochGrant: true`). The
  head's lanes were sealed with the publisher's (CLI's) epoch key; the browser's spurious
  key can never match it, so every definition/Shared Value lane is unreadable. Because the
  boundary's `grantsReady` only counts *some* current-epoch grant for the presented Device,
  the spurious grant suppresses the `pending-grants` repair; and `wrapEpochKeyToPeers`
  (`apps/cli/src/workflow.ts:651`) skips peers with `hasEpochGrant`, so the re-share never
  reaches the browser. The same self-mint flaw exists in the CLI mirror
  (`apps/cli/src/workflow.ts:2726`), so a second CLI Device on an existing project repeats
  it. The service cannot distinguish a spurious grant from a real one (both are validly
  signed and sealed to the recipient), so the gate belongs client-side.
- **Why the suites missed it:** the e2e fixtures script *both* the boundary and the grant
  bootstrap and seal the *same* epoch key into the scripted grant
  (`workspace-stale-epoch.spec.ts` et al.), so the key mismatch — which requires a real
  publisher key plus a real second Device — cannot occur in fixtures.
- **Fix (this campaign, D-011):** a newly enrolling Device must not self-mint an epoch grant
  when any peer Device already holds a `CURRENT_PROJECT_EPOCH` grant for the current
  epoch. The web enrollment gate (`workspace-shell.tsx`) skips the self-issued
  `grants/bootstrap` POST whenever a peer reports `hasEpochGrant`; the CLI `pull` gate
  (`workflow.ts`) skips the bootstrap and instead reports a pending action telling an owner
  or admin to run `dotrelay pull` from their own Device. The web `repairStaleEpoch`
  self-mint is deliberately left un-gated (D-011): it is only reached on a stale-epoch
  boundary and mints for the *new* epoch, which is the correct first-device recovery after
  a rotation.
- **Verification (live, this campaign):** on the live self-hosted deployment the stuck
  browser Device's local key storage was cleared and the browser re-enrolled a fresh Device
  (`d926aba4`). With the fix in effect the new Device did **not** self-mint: the boundary
  reported `grantsReady: false`, no `grants/bootstrap` POST was made, and the UI showed
  "Waiting for project keys" (no `grant_objects` row for the new Device). A key-holder's
  `dotrelay pull` (CLI Device `5211775b`, which holds the real epoch-1 key) then wrote 12
  values and provisioned the real key to the browser (grant `b99f4d28`, sender = the CLI
  Device). Post-repair the browser's boundary reports `grantsReady: true` with
  `epochGrant` present, and the editor reads the head: the 12 Variable definitions and 10
  Shared Values decrypt via the re-shared key, while the 2 owner-A User-defined Values stay
  sealed to the CLI publisher Device's per-device key and surface the F-008
  user-defined-branch alert — the correct E2EE residual, not a defect.
- **Regressions:** CLI unit `pull does not mint a spurious key when a peer holds the epoch
  key` (workflow.test.ts: served boundary `grantsReady: false` plus a peer with
  `hasEpochGrant: true` → zero grant-bootstrap calls, pending action surfaced); web e2e
  `enrollment skips the self-issued epoch grant when a peer holds the key`
  (workspace-enrollment-storage.spec.ts: intercepts `grants/bootstrap`, asserts zero POSTs
  during enrollment). The four stale-epoch e2e tests still pass, confirming the un-gated
  `repairStaleEpoch` self-mint (first-device recovery after a rotation) is intact.
- **Residual live state (intended, not a gap):** the original stuck Device `40a0a545`'s
  spurious grant row (`01a055d2`) is permanent — `grant_objects` is append-only (a
  trigger rejects UPDATE/DELETE), so the spurious row cannot be scrubbed. That Device is
  unrecoverable at epoch 1 (`wrapEpochKeyToPeers` skips already-granted peers and the
  spurious row cannot be removed); recovery for it requires an epoch rotation and
  re-publish. The fix prevents the dead-end for every future enrollment.

## F-010 (PRODUCT GAP) No user-facing trigger for Project epoch key rotation — owner/admin recovery path unreachable
- **Status:** BLOCKED (product decision; GitHub issue #229, 2026-09-21)
- **Symptom:** the web recovery copy (`workspace-shell.tsx:2194-2196`) tells users "Owners
  and Admins can also rotate the project's keys", and `docs/wiki/synchronization.md:21-23`
  documents key rotation as a first-class flow — but no shipped interface can initiate a
  rotation. The only code path is the raw protocol endpoint
  `POST /api/v1/operations/:operationId/epoch-transitions`
  (`apps/api/src/protocol/routes.ts:679-855`), which requires a pre-staged, device-signed
  `EPOCH_ROTATION` operation: there is no web UI button, no `dotrelay` CLI subcommand
  (`apps/cli/src/args.ts` COMMANDS contains no rotation command), and no `packages/client`
  initiator.
- **Impact:** a Device stuck without the current epoch's real key (the F-009 dead end:
  spurious grant row — e.g. live Device `40a0a545` and its grant `01a055d2` on project
  `1a04be60-d689-4f99-9e7e-eba524e787fe`, epoch 1) can never be unstuck by a human through
  any shipped interface, because `wrapEpochKeyToPeers` skips already-granted peers and
  re-enrollment only mints at the current epoch. Recovery requires an epoch rotation that
  only an operator with signing tooling can drive.
- **Why not fixed here (D-012):** building a rotation initiator means constructing and
  signing `EPOCH_TRANSITION` revision artifacts client-side — new E2EE surface with its own
  failure modes — which is a product decision, not a defect fix. Issue #229 records the
  options (web owner/admin action, `dotrelay rotate` CLI subcommand, or correcting the
  copy/docs to mark rotation as an operator operation).
- **Verification of the gap (this campaign):** inventory scan of all product surfaces —
  web (`workspace-shell.tsx` has no rotation action), CLI (`apps/cli/src/args.ts`
  COMMANDS/SUBCOMMANDS), `packages/client` (no initiator), and docs (recovery copy +
  `synchronization.md`) — against the single protocol endpoint; live audit state confirmed
  the F-009 dead-end Device is unrecoverable at epoch 1.

## F-011 (FIXED) `dotrelay pull`'s unchanged and `--stdout` output variants drop pending grant remediation actions
- **Status:** FIXED_AND_VERIFIED (this campaign; hermetic CLI unit regression plus fresh full verify)
- **Symptom:** in the F-009 scenario (the Device holds no Project epoch grant while a peer
  Device holds the real key), the remediation pending action — *"This Device is missing
  the Project epoch grant; an owner or admin can provision it by running `dotrelay pull`
  from their own Device"* — is silently dropped whenever `dotrelay pull` reports
  "No changes found" (the common in-sync case) or is run with `--stdout`, so the user
  is told the pull succeeded with no hint that the Device still cannot read the
  environment.
- **Root cause:** `runProtectedWorkflow`'s pull handler merges
  `pendingActionsField(synced.workflow.pendingActions)` into the history, diff, and
  file-write output variants (`apps/cli/src/workflow.ts`), but the `unchanged`
  early-return branch and the `--stdout` return branch built their result objects
  without it. The missing-grant remediation is pushed into `workflow.pendingActions` by
  the F-009 gate, so it existed in state — only those two output paths dropped it on
  serialization.
- **Why the suites missed it:** the F-009 CLI regression test ran `pull` with the
  default `.env` output into the package directory, so which branch executed depended on
  whether a leftover `apps/cli/.env` existed (gitignored, invisible to
  `tracked-tree:clean`): first run with no file → write path (which merged
  pendingActions) → pass, and that run created the file; any later run → unchanged
  branch (which dropped it) → fail. The campaign's last full verify replayed the stale
  turbo-cache pass of that suite instead of re-executing it, so the closeout green did
  not exercise the failing branch — a false green that masked the defect until a fresh
  run against the existing file surfaced it.
- **Fix (this campaign):** the `unchanged` branch and the `--stdout` return now merge
  `pendingActionsField(...)` exactly like the other output variants, so no output path
  can silently lose a pending grant remediation.
- **Verification:** the F-009 CLI unit test was made hermetic — it pulls to a per-suite
  temp output with the Git tracking probe pinned to "outside", runs `pull` twice (first
  the write path, then the matching in-sync run), and asserts the second run returns
  `unchanged: true` **and** the remediation `pendingActions`. Pre-fix, that assertion
  fails on the unchanged run; post-fix the full CLI unit suite is green (356 pass /
  0 fail) and a fresh full verify with the turbo cache invalidated re-executed
  `@dotrelay/cli#test:unit` (not a cache replay) green.

## F-012 (FIXED) Local `test:integration` stage skipped every test — silent all-skip false green
- **Status:** FIXED_AND_VERIFIED (this campaign; fresh 19 pass / 0 fail run with the turbo cache invalidated)
- **Symptom:** every local `bun run verify` run reported `test:integration` as green, but the
  suite actually executed zero tests: `23 skip / 0 pass / 0 fail` (`/tmp/verify-final.log`,
  `/tmp/verify-final2.log`, `/tmp/verify-final4.log`). The green was vacuous — nothing
  integration-related (persistence or trust) ever ran locally; only CI exercised it.
- **Root cause:** `bun run <script>` loads `.env` **in-process only**; it does not export
  the variables to the shell or to child processes. The stage was
  `bun scripts/test-services.ts && turbo run test:integration`, so the `turbo` child
  process had no `DATABASE_URL`. The integration suites gate on
  `process.env.DATABASE_URL ? describe : describe.skip`
  (`packages/database/src/persistence/postgres.integration.test.ts:29`,
  `trust.integration.test.ts:24`), so with the variable absent every describe was
  skipped, and turbo happily cached that all-skip as a green task. `test-services.ts`
  itself only checked for `DATABASE_URL` in its own process (where `bun run` had
  loaded it), so its readiness check passed misleadingly. CI was unaffected because the
  workflow sets `DATABASE_URL`/`VALKEY_URL` as job-level env (`ci.yml:79-81`). A
  controlled `/tmp/envprobe` experiment confirmed the behavior: under `bun run <script>`
  a child process sees `DATABASE_URL` unset, while `bun p.ts` (direct file execution)
  and `bun run --env-file=.env p.ts` both export it.
- **Fix (this campaign):** `scripts/test-services.ts` is replaced by
  `scripts/test-integration.ts`, which (1) loads the repository `.env` into the running
  process (`process.loadEnvFile`, guarded by `existsSync` so CI jobs without a `.env`
  still work off their job env vars), (2) fails fast with an actionable error if
  `DATABASE_URL` is still unset, (3) verifies both services (`SELECT 1` on PostgreSQL,
  `ping` → PONG on Valkey), and (4) spawns `bun x turbo run test:integration` with the
  complete `process.env` so the variables reach the integration tasks; it exits with
  turbo's status. The old readiness-only script is deleted (its only consumer was the
  stage); `package.json` now runs `bun scripts/test-integration.ts`, and
  `.audit/RUNBOOK.md:34` documents why the wrapper exists. A broken environment can no
  longer degrade to a silent all-skip: a missing URL or a dead service throws before
  any test runs.
- **Verification:** after invalidating the stale turbo cache entries,
  `bun run test:integration` executed the real suites against the local
  `dotrelay-postgres`/`dotrelay-valkey` containers: **19 pass / 0 fail / 100 expect()
  calls, `0 cached, 1 total`** (the earlier `23 skip` count included 2 bun "(unnamed)"
  describe artifacts that only appear when the describes are skipped; no conditional
  skip remains beyond the `DATABASE_URL` gate, which the wrapper now guarantees is set).
  Every prior local "test:integration green" statement — including the campaign's
  earlier full-verify logs — was vacuous and is corrected in INVENTORY (TEST-INTEG-001)
  and COVERAGE.

## F-013 (FIXED) e2e `workspace-invitations` spec races the workspace trust settle on a cold dev server
- **Status:** FIXED_AND_VERIFIED (this campaign; 4/4 pass on a cold server start, full e2e suite 102 pass / 0 fail)
- **Symptom:** the fresh full verify (`/tmp/verify-final4.log`) failed in `test:e2e`
  (1 failed / 101 passed): `workspace-invitations.spec.ts › resolving an unknown GitHub
  login keeps the form and reports the problem` — `TimeoutError: locator.click: Timeout
  5000ms exceeded` while clicking `getByRole("button", { name: "Invite member" })`. The
  error-context snapshot showed the workspace **trust gate still rendered** ("Trust this
  server" card, the `trust-profile` setup action) and the main view still on the Team
  landing state, while the sidebar had already selected Team — the click raced the
  boundary/trust settle.
- **Root cause:** that run started a **cold** Next dev server (the long-running hub
  `web` process was stopped for the verify, so Playwright's `webServer` with
  `reuseExistingServer: !process.env.CI` launched a fresh `bun --cwd apps/web dev`
  (`playwright.config.ts:10-16`)); `/workspace` compiled on first hit and the first
  spec to reach the protected Team surface paid the full compile + boundary-verify
  cost. While the `trust-profile` setup action is active, the shell replaces the Team
  view with the trust gate (`workspace-shell.tsx:2813-2829`), so "Invite member" simply
  does not exist until trust settles. Every other spec that drives a protected surface
  calls `trustWorkspaceServer(page)` after `page.goto("/workspace")`
  (`apps/web/e2e/trust-server.ts:8-23` — waits `workspace-loading` hidden ≤15 s, settles
  500 ms, confirms the gate if present, no-op when trusted); `workspace-invitations.spec.ts`
  never called it, so on a cold server its four tests acted on the Team surface while
  the gate was still settling. Once the server was warm (or in CI, where
  `reuseExistingServer: false` starts it the same way and the sibling specs' settles
  prime the page), the identical clicks pass — a pure timing race, not a product
  regression (the F-011 fix touched CLI code only; the web invitations surface is
  untouched).
- **Fix (this campaign):** `workspace-invitations.spec.ts` now imports
  `trustWorkspaceServer` and calls it after each of its four `page.goto("/workspace")`
  sites, matching the sibling-spec convention. The helper is no-op-safe (returns when
  the gate is absent), so warm runs and CI are unaffected.
- **Verification:** with nothing on :3000 (guaranteeing Playwright's `webServer`
  started a fresh, cold dev server), the spec passed 4/4 in 8.5 s, and the full
  `bun run test:e2e` suite then passed **102 pass / 0 fail** against the same cold
  start. No assertion was weakened.

## F-014 (PRODUCT GAP) No surface provisions member key grants or activates PENDING_KEY_GRANT memberships
- **Status:** BLOCKED (product decision — already tracked as GitHub issue #133 `ready-for-agent`,
  decision-settled to spec #209; recorded in this ledger 2026-09-21 because the prior
  campaign captured the analogous epoch-rotation gap as F-010/#229 but never recorded this one)
- **Symptom:** after a new Member accepts an invitation, their Membership is `PENDING_KEY_GRANT`,
  and the only transition to `ACTIVE` is the Team owner/admin provisioning the required key grants
  to the Member's Devices and then committing an activation. No shipped surface (web UI, `dotrelay`
  command, or HTTP route) performs either step. The Member is left in a terminal pending state: the
  web catalog hides `PENDING_KEY_GRANT` memberships (residual 4), so the Member sees "No teams yet",
  and a Member-side `dotrelay pull` fails with `membership_not_key_provisioned`.
- **Evidence (re-verified at HEAD 4b234bc, 2026-09-21):** `MembershipRepository.activate`
  (`packages/database/src/persistence/repositories.ts:1984`; PENDING guard :2007, ACTIVE
  transition :2055) has no production caller — its only invoker is the integration test
  (`packages/database/src/persistence/trust.integration.test.ts:614`). The only production
  grant-creation caller is `POST /api/v1/grants/bootstrap` (`apps/api/src/index.ts:663`), which
  hard-codes `keyKind: "PROJECT_EPOCH"` / `grantKind: "CURRENT_PROJECT_EPOCH"` (:812-813), never
  passes `membershipId`, and restricts recipients to the actor's own ACTIVE devices.
  `GrantRepository.create` does accept a `membershipId`-scoped grant but validates the membership
  only as `PENDING_KEY_GRANT` on the same team (`repositories.ts:2862-2866`), and no route or CLI
  command exercises that branch. The CLI's peer provisioning (`apps/cli/src/workflow.ts:634`
  `wrapEpochKeyToPeers`) targets only the actor's own `boundary.peerDevices`.
- **Why not fixed (D-015):** choosing the trigger (web owner/admin action, a `dotrelay` CLI
  subcommand, or documenting the operation as operator-only) and the cross-User wrapping semantics
  is a product decision, already settled in #133 (decision-settled 2026-09-17 → spec #209,
  decisions 2 and 7: donor re-wrap of the Project epoch key to the Member's Devices,
  owner/admin-authorized, per-Project per-Device grant set, then the existing
  PENDING_KEY_GRANT→ACTIVE transition). This audit neither invents a new endpoint nor reopens
  that design.
- **Not an exploitable defect:** the state is fail-closed — a `PENDING_KEY_GRANT` Member cannot
  read, publish, or be granted cross-tenant content (proven live: user B in that state sees an
  empty catalog and is 404/403 on the owner's resources, SEC-AUTHZ-001/002). The gap is a missing
  product workflow, not a privilege boundary.
- **Disposition:** cross-referenced to the existing open issue #133 (`ready-for-agent`) and spec
  #209; no duplicate filed. The prior campaign recorded the analogous epoch-rotation gap as
  F-010/#229 but left this member-provisioning gap unrecorded.

## F-015 (RECORD, TRACED IN #137) CLI re-mints the publication operation on an uncertain finalize
- **Status:** BLOCKED (tracked — open GitHub issue #137 "Reconcile uncertain publication outcomes before
  asking users to publish again", `bug` + `ready-for-agent`, design settled in spec #209 decision 11;
  recorded in this ledger 2026-09-21 by the second-pass CLI sweep; no code change in this audit)
- **Symptom:** `dotrelay init`/`push`/`rollback` generate a fresh `operationId` per attempt
  (`apps/cli/src/workflow.ts:3175-3218`); when the finalize response is lost after the service
  committed the Revision, the catch at :3197-3220 cancels the operation (silently swallowing the
  outcome) and throws. The next invocation mints a fresh operation id — the retry re-mints a
  publication the user believes failed, and there is no persisted publication record and no
  operation-status consult anywhere in the CLI or `packages/client/src/sync/transport.ts`
  (single-shot begin/stage/finalize/cancel; `Idempotency-Key` only on begin). `push`'s peer
  re-share (`shareEnvironmentWithinPeerDevices`, workflow.ts:3284-3315) has the same pattern.
- **Why it is a defect but not fixed here:** spec #209 decision 11 (settled 2026-09-17) prescribes
  the fix — a persisted per-attempt publication record (operation id, expected head, attempt
  count) keyed by Environment + input, idempotent re-finalize of the same operation, and/or a
  read-only operation-status endpoint, with cancellation of possibly-committed operations
  removed. The implementing surface spans CLI state storage + a protocol transport change + a
  new service endpoint (decision 11 names the endpoint); that is the scope of #137, not a
  surgical audit fix.
- **Consistency note:** the same codebase already implements decision 11 on the two recovery
  surfaces — `createRecoveryBackup` stages a `.pending` kit and reconciles against the
  service's current envelope on uncertain failure (workflow.ts:2030-2105, pinned by
  workflow.test.ts:3943) and `restoreRecoveryKit` persists the full pending operation before
  posting and resumes with the same operationId (workflow.ts:2476-2520, pinned by
  workflow.test.ts:4540-4544) — so the publication path is the lone straggler, which makes the
  #137 implementation a pattern extension rather than a new design.
- **Not exploitable:** the re-mint cannot create unauthorized state — the re-finalized operation
  is still bound to the same signed command bytes, digest, and actor device; worst case is a
  duplicated Revision the operator can see in `history` (the service serializes publications and
  records each as a distinct Revision), plus a user-facing "failed" claim on an outcome that may
  have committed. No cross-tenant or crypto-boundary consequence.
- **Disposition:** cross-referenced to the existing open issue #137 (`bug`, `ready-for-agent`)
  and spec #209 decision 11; no duplicate filed. The prior campaign's ledger never recorded the
  CLI sweep's finding because the sweep is new to this session (2026-09-21).
