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
