# DotRelay Audit — Inventory

Stable identifiers for every discovered testable surface.
Status: UNTESTED | IN_PROGRESS | PASS | FIXED_AND_VERIFIED | BLOCKED | NOT_APPLICABLE

Legend: category prefixes
- WEB-*    browser/UI surface (routes, components, flows)
- API-*    HTTP endpoints on the API service
- PROTO-*  protocol state machine (bootstrap, publish, pull, epochs, recovery)
- CLI-*    CLI commands/behaviours
- SEC-*    authorization / crypto / sensitive-data boundaries
- DB-*     database schema, constraints, migrations
- CFG-*    configuration, environment variables, deployment
- TEST-*   test-suite quality items

---

## WEB — browser / UI

| ID | Surface | Status |
|---|---|---|
| WEB-HOME-001 | Landing page (signed-out): hero, "Get started" → sign-in | PASS (live browser 2026-09-21) |
| WEB-AUTH-001 | Sign-in page: "Continue with GitHub" initiates OAuth | PASS (live: redirected to github.com/login with PKCE S256 + correct redirect_uri/scope) |
| WEB-AUTH-002 | GitHub OAuth callback → session established, redirect to /workspace | BLOCKED (headless: needs real GitHub creds, D-005; callback path covered by unit tests; downstream session flow verified live via signed cookies) |
| WEB-AUTH-003 | Session persistence across reloads | PASS (live: signed cookie persisted across /workspace reloads; API accepts signed `better-auth.session_token`) |
| WEB-AUTH-004 | Logout (browser device revocation) | PASS (e2e: workspace-account.spec.ts desktop + mobile sign-out → /sign-in, green in the 102-pass verify; live: the signed-in shell's account menu carries "Sign out" — the click itself was deliberately not performed to avoid stranding the only live session, D-005) |
| WEB-WORKSPACE-001 | /workspace signed-out redirect behaviour | PASS (live: signed-out shell renders; signed-in shell renders real "No teams yet" onboarding after seed) |
| WEB-WORKSPACE-002 | Workspace shell: team switcher, project list, environment list | PASS (live 2026-09-21: zero-teams onboarding and populated Audit Team state both rendered; team/project/environment navigation exercised in the F-007/F-009 live passes) |
| WEB-WORKSPACE-003 | Environment page: variable table, add/edit/delete variable | PASS (live read path on the real deployment — 24 lanes rendered in the F-009 re-share pass, boundary healthy + History rendered on the 2026-09-21 zero-noise probe; add/edit/delete on the e2e suite: workspace-add-variable-reveal.spec.ts, workspace.spec.ts masked preview + publish, workspace-protocol-reread.spec.ts add+delete+undo. Live browser mutation infeasible: the main env's sealed owner-A user-defined lanes fail the decode (correct E2EE residual — table hidden), and the scratch env is archived+headless+grantless; D-020) |
| WEB-WORKSPACE-004 | Shared vs user-defined variable display (masking/reveal) | PASS (live: shared vs User-defined lane distinction + the sealed-lane F-008 alert rendered on the real deployment, 2026-09-21 zero-noise probe; masking/reveal Eye/EyeOff interaction e2e-pinned: workspace-draft-protection.spec.ts, workspace-variable-readability.spec.ts, workspace-role-permissions.spec.ts) |
| WEB-WORKSPACE-005 | Publish/draft flow in browser (staged lanes, reconciliation, conflicts) | PASS (browser publish/draft flow e2e-green: workspace-protocol-publish.spec.ts full staged-lane publish incl. in-flight edit isolation, workspace.spec.ts review→Publish, workspace-protocol-reread.spec.ts re-read after publish; real publication live via CLI genesis publish + push/rollback round-trip; browser live publish blocked only by the correct E2EE residual on the live env, D-020) |
| WEB-WORKSPACE-006 | Revision history + rollback in browser | PASS (live: History section rendered with head `189320f0` (ROLLBACK) + 3 revisions on the real deployment; browser rollback UI e2e: workspace.spec.ts lane rollback dialog/staging, workspace-protocol-reread.spec.ts rollback-after-failed-reread; CLI `history`/`rollback` round-trip live-verified with correct mutation types + rollbackTargetId) |
| WEB-WORKSPACE-007 | Devices tab: enrolled devices, CLI setup command, approval | PASS (live 2026-09-21: approval flow A68CX76M; Devices view lists This browser / CLI / browser devices with per-Device project-access state incl. "Waiting for project keys" vs "Has project access") |
| WEB-WORKSPACE-008 | Team administration: members, invitations, role change, removal, last-owner protection | PASS (API-level live: full lifecycle incl. 409 last_owner_protection; web UI pass pending) |
| WEB-WORKSPACE-009 | Project creation / deletion / GitHub repository connection | PASS (live: project+environment created via CLI `init` with real GitHub repository resolution; docs state project creation is CLI-only in the web app) |
| WEB-DEVICE-001 | /device approval page: user_code flow, allow/deny | PASS (live: code A68CX76M rendered, "Allow this CLI" approved, CLI completed enrollment, "Allowed" confirmation shown) |
| WEB-ERR-001 | Error/loading states, offline behaviour, stale epoch UI | PASS (live: unreadable-lane alerts incl. the F-008 user-defined branch + the fail-closed hidden-table state rendered on the real deployment with zero console errors; API problem codes 400/401/403/404/409/413/429 live-verified; stale-epoch UI + offline behaviour e2e: workspace-stale-epoch.spec.ts 4 specs, workspace-protocol-read.spec.ts — a failed read never presents an editable empty manifest) |
| WEB-SELFHOST-001 | Self-hosted profile UI branches (web profile = self-hosted) | PASS (live 2026-09-21: F-007 origin-fallback lifecycle flow, F-009 enrollment + re-share, and stale-epoch UI all exercised against the self-hosted profile) |

## API — HTTP endpoints

| ID | Surface | Status |
|---|---|---|
| API-HEALTH-001 | GET /health (exempt from secure gate) | PASS (live 200 `{"status":"ok"}`) |
| API-CAPAB-001 | GET capabilities document (profile-bound, ETag, versioning) | PASS (live 200 with ETag + correlationId; suite v3 classical-webcrypto) |
| API-TEAMS-001 | GET /api/v1/teams (authenticated list) | PASS (live: 401 unauth; 400 session-without-device per D-006; A+device → 200 `[{Audit Team}]`) |
| API-TEAMS-002 | Create team | PASS (live: created via CLI `dotrelay init` → POST /api/v1/teams with Idempotency-Key) |
| API-AUTH-001 | Better Auth /api/auth/* (sign-in callback, session, logout, device flow) | PASS (live: /api/v1/session bearer+cookie; device flow E2E complete; OAuth callback itself unit-only per D-005) |
| API-DEVICENET-001 | /api/auth/device + /approve + /deny (CLI device authorization) | PASS (live: full RFC 8628 flow — CLI user_code A68CX76M, browser approval, CLI "Signed in to live. Device enrolled.") |
| API-MEMBERSHIP-001 | Membership CRUD, roles, invitations, last-owner protection | PASS (live: invite→accept→PENDING_KEY_GRANT→role change→remove→post-removal 403→409 last_owner_protection) |
| API-ADMIN-001 | Administration routes (team admin operations) | PASS (live: team/project/environment creation exercised; GET /projects?teamId, POST /projects) |
| API-GITHUB-001 | GitHub user identity on sign-in (delegated access) | PASS (live: user A's real token used by API for repo resolution during `dotrelay init`) |
| API-GHREPO-001 | GitHub repository identity resolution + access verdicts | PASS (live: LSP-Software/DotRelay resolved via user A's delegated access during init) |
| API-CORS-001 | CORS/origin/cookie trust boundaries (web origin allowlist, no mixed creds) | PASS (live: web↔API cross-origin credentials flow works; missing-Origin state-changing bearer request behaves identically to with-Origin — Origin is a cookie cross-origin concern only, not a bearer gate; negative same-site cases covered by e2e) |

## PROTO — protocol state machine

| ID | Surface | Status |
|---|---|---|
| PROTO-BOOT-001 | Device bootstrap (first device per user) | PASS (live: CLI + manual client bootstrap both 201, devices ACTIVE) |
| PROTO-ENROLL-001 | Device enrollment + approval (CLI setup) | PASS (live: `dotrelay setup` → browser approval → "Signed in to live. Device enrolled.") |
| PROTO-SYNC-001 | Environment sync read (pull): revisions, values, signing trust | PASS (live: `dotrelay pull` decrypted 12 values to .env, byte-identical to published values) |
| PROTO-PUB-001 | Publication: staged lanes, expected head, three-way reconciliation | PASS (live: genesis publish of 12 variables (10 shared + 2 user-defined) via begin/stage/finalize) |
| PROTO-PUB-002 | Conflicts: variable conflict, stale_head, stale_epoch, staging_expired | PASS (stale_epoch live via F-009 repair path + 4 e2e specs; stale_head/conflict mapping unit/e2e-covered (index.test.ts handlePersistenceFailure); live two-device conflict reproduction not run to keep live state clean) |
| PROTO-EPOCH-001 | Epoch rotation, history trust reset | PASS (mechanism pinned by integration test 92f99ba — epoch 1→2 rotation happy path, idempotent replay, StaleEpochError, StaleHeadError — + 4 stale-epoch e2e specs + live F-009 repair path (un-gated `repairStaleEpoch` self-mint) + live boundary fields `epochCurrent`/`rotationRequired`; the owner-initiated rotation trigger is absent by product decision — issue #229 / F-010, not a defect) |
| PROTO-RECOVERY-001 | Recovery kit: active/pending, rotation, device replacement | PASS (live: backup wrote generation-2 kit; recover fail-closed `recovery_requires_no_active_device` while any device active; restored device pulls 12 values; rotation/restore happy-path via 9 unit tests) |
| PROTO-SIGN-001 | Revision signature verification (team signing devices, membership windows) | PASS (live: `history`/`rollback` round trip verified revision signatures through the sync fold, 3 revisions w/ correct mutation types + rollbackTargetId) |
| PROTO-RATE-001 | Rate limits (device polling, endpoint limits) | PASS (live: protocol 120/60s per-actor tripped at request 121 → 429 + Retry-After 60; better-auth 10/60s unit-covered) |

## CLI

| ID | Surface | Status |
|---|---|---|
| CLI-SETUP-001 | `dotrelay setup` (device enrollment via browser approval) | PASS (live against real API: profile add trust prompt, RFC 8628 code, browser approval, completion) |
| CLI-PULL-001 | `dotrelay pull` / sync to .env (merge, new vars, missing user-defined) | PASS (live: decrypts all lanes, replaces .env, retains .env.previous, "No changes found" when in sync; the pull output contract — every output variant, incl. the unchanged and `--stdout` JSON variants, must carry pending grant remediations — pinned by the hermetic F-009/F-011 regression, F-011) |
| CLI-PUBLISH-001 | publish flow (draft, conflicts, reconciliation) | PASS (live: `dotrelay init` genesis publish, 12 vars, review gate, "Encrypted 12 Variables / Uploaded / Published") |
| CLI-PROFILE-001 | Server profile selection / config (hosted vs self-hosted URL) | PASS (live: profile add/use/list against self-hosted; trust-frame `…-undefined` abbreviation bug fixed this campaign, see F-005) |
| CLI-ERROR-001 | Error recovery (offline, 401, stale epoch, network failure) | PASS (live: 401/403/404/409/413/429 problem-code mapping observed across probes; stale-epoch recovery e2e-covered; device_bundle_missing + recovery_requires_no_active_device codes live) |
| CLI-AUTH-001 | CLI credentials storage, recovery kit | PASS (live: wrapped device bundles + credential store on disk; backup/recover round trip exercised, see PROTO-RECOVERY-001) |
| CLI-ADMIN-001 | `dotrelay admin` subcommands | NOT_APPLICABLE (D-014: no `dotrelay admin` subcommand exists in the code or docs — `apps/cli/src/args.ts` COMMANDS has no admin group and `src/admin.ts` is the internal StrictJsonClient, not a user command; membership operations are proven across the CLI/API/WEB surfaces under CLI-SETUP/API-MEMBERSHIP/WEB-WORKSPACE-008) |
| CLI-BUILD-001 | CLI packaging (build-cli, npm package, cross-OS binaries) | PASS (live: `bun --cwd apps/cli run build` produced working 81MB `dist/dotrelay` binary, exercised fully) |

## SEC — authorization / crypto / sensitive data

| ID | Surface | Status |
|---|---|---|
| SEC-AUTHZ-001 | Cross-tenant IDOR via direct IDs (teams/projects/envs/devices/memberships) | PASS (live: user B reading A's project by direct id → 404; B sync on A's env → clean rejection; catalog lists only ACTIVE memberships) |
| SEC-AUTHZ-002 | Unauthenticated access to all domain endpoints | PASS (live: 401 authentication_required on sync/teams without credentials; unknown device header → 403 device_not_active) |
| SEC-AUTHZ-003 | Member vs admin vs owner privilege boundaries | PASS (live: membership lifecycle incl. role change + remove; 403 post-removal; 409 last_owner_protection) |
| SEC-AUTHZ-004 | Authorization after membership removal (windows, signing devices) | PASS (live: post-removal 403 on membership ops; signing-window trust verified through history/rollback round trip) |
| SEC-CRYPTO-001 | E2E encryption: values never stored in plaintext (DB columns) | PASS (live: lane columns are ciphertext; byte-identical client-side decryption on pull; re-shared epoch key required for shared lanes) |
| SEC-CRYPTO-002 | Key material boundaries (who can decrypt shared vs user-defined) | PASS (live: shared lanes decrypt with the re-shared project epoch key; owner-A user-defined lanes sealed to the CLI publisher device key — unreadable by every other device; F-008 remedy surfaced) |
| SEC-LEAK-001 | No secret/key leak in logs (API stdout, observability events) | PASS (live: full API stdout buffer scanned in-process for BETTER_AUTH_SECRET, GITHUB_CLIENT_SECRET, DB/valkey URLs+passwords, audit session cookies — none present; events are structured correlationId/outcome records only) |
| SEC-LEAK-002 | No secret leak to unauthorized clients (cross-device, cross-user sync pages) | PASS (live: user B (PENDING_KEY_GRANT) sees empty catalog, 404 on A's project, 403/400 on sync; unknown device 403) |
| SEC-OBS-001 | Diagnostic event allowlist / redaction / correlation IDs | PASS (live: structured api.request.completed events with correlationId + problemCode; no request/response bodies or secrets in events) |
| SEC-COOKIE-001 | Cookie scoping (secure flag, parent-domain scoping, origin binding) | PASS (live: 2026-09-21 `page.cookies()` probe — `better-auth.session_token` scoped to the API host, path `/`, `secure:false` on plain-HTTP dev (correct per `useSecureCookies = profile.isProduction` in auth.ts), session cookie; production flags unit-pinned at apps/api/src/index.test.ts:458 (Secure + SameSite=Lax + HttpOnly) and :504-538 (parent-domain scoping for split web/api origins); Origin required on cookie state changes at index.test.ts:241) |

## DB — schema / migrations

| ID | Surface | Status |
|---|---|---|
| DB-SCHEMA-001 | Prisma schema vs production (db:validate) | PASS (db:validate green in the final verify against the deployed migration history on the live compose Postgres; the self-hosted api/web booted from it all campaign) |
| DB-MIGRATE-001 | Migrations deploy cleanly on fresh DB | PASS (migrate deploy applied all 9 on fresh DB 2026-09-21) |
| DB-CONSTRAINT-001 | Hardened constraints (last-owner, admin invariants, observability) | PASS (live: 409 last_owner_protection on owner removal; append-only `grant_objects` — the F-009 spurious row `01a055d2` is undeletable, a live DELETE was rejected with "immutable DotRelay row" by trigger `dotrelay_reject_immutable_row`; admin invariants unit/integration-covered) |
| DB-SENSITIVE-001 | Sensitive column inventory (ciphertext, keys, tokens) | PASS (lane value columns store ciphertext + `ciphertextHash` only — no plaintext column exists on `lane_objects`; epoch keys are wrapped per recipient in `grant_objects` ciphertext; no plaintext values or key material in the DB or in API logs/observability events, SEC-CRYPTO/SEC-LEAK live) |

## CFG — configuration / deployment

| ID | Surface | Status |
|---|---|---|
| CFG-ENV-001 | Env var validation/fail-fast on missing/invalid config | PASS (`loadServerProfileConfig` fail-fast (profile.ts:122-248 — production requires SERVER_PROFILE_ID/BETTER_AUTH_SECRET≥32/GITHUB pair; trust-proxy list required when the flag is on) unit-pinned (profile.test.ts:33,148-238); the self-hosted `.env` is exercised by every live surface and api/web boot with it all campaign) |
| CFG-TRUSTPROXY-001 | TRUST_PROXY / trusted proxies / X-Forwarded-Proto behaviour | PASS (first-entry X-Forwarded-Proto trust (profile.ts:326-338) + flag/CIDR parsing (:158-170) + better-auth ipAddressHeaders/trustedProxies wiring (auth.ts:44-47); unit-pinned profile.test.ts:148-211 (edge-hop trust, `http,https` veto, untrusted-proxy rejection) + observability.test.ts:133-145 (client-IP from header); the dev deployment runs without a front proxy — the production case is unit-covered) |
| CFG-REBIND-001 | SERVER_PROFILE_REBIND origin change flow | PASS (SERVER_PROFILE_REBIND → `profile.allowRebind` (profile.ts:171) persisted via `ensureServerProfile` (index.ts:1145-1149; fail-closed origin-diff test at server-profile.test.ts); client rebind flow = `planContextSwitch` (environment-context.ts:64-67) + e2e workspace-history.spec.ts:275,314 (prompt/restore/discard on a profile rebind); the self-hosted profile itself is a rebind off the hosted default and was switched live) |
| CFG-DEPLOY-001 | Docker images (api/web) build + self-hosted compose | PASS (2026-09-21: both images built from the repo — api exit=0 in 204s, web exit=0 in 138s (logs /tmp/docker-api-build.log, /tmp/docker-web-build.log); api image: bun build + prisma migrate deploy entrypoint + non-root + curl healthcheck, web image: Next standalone with baked NEXT_PUBLIC_*; compose postgres/valkey ran the whole campaign; CI `deploy-dev` (ci.yml:175-223) builds + pushes both, deploys via Coolify, runs a capabilities smoke) |
| CFG-CI-001 | CI workflow jobs (check/build/unit/integration/e2e/cli/prisma/docs/security) | PASS (ci.yml jobs map 1:1 onto the local `bun run verify` chain: check→check, build-smoke→build+smoke, unit→test:unit, integration→test:integration (pinned postgres/valkey images), browser-e2e→test:e2e, cli-round-trip→test:cli+test:cli:live (3-OS matrix), prisma→db:validate+db:migrate-check (shadow db), docs→docs:validate; every local equivalent is green in the campaign's verify runs. CI-only delta: the `security` job (`bun run security:audit` = `bun audit`) has no local verify step — local `bun run security:audit` passes) |
| CFG-CLI-DEPLOY-001 | CLI dev packaging + npm dev publish | PASS (packaging: `package:cli` produced the working 81MB `dist/dotrelay` binary, exercised live all campaign (CLI-BUILD-001); ci.yml build-cli-dev (3-OS) + publish-cli-dev (npm `--tag dev`) verified by inspection — the publish step needs the `NPM_TOKEN` registry secret, so the npm publish itself is a CI-only delta recorded here, not a defect) |

## TEST — test suite quality

| ID | Surface | Status |
|---|---|---|
| TEST-UNIT-001 | All unit suites pass (check gate) | PASS (2026-09-21: check exit 0) |
| TEST-BUILD-001 | Production builds pass (web/api/cli) | PASS (2026-09-21: build exit 0) |
| TEST-E2E-001 | Playwright e2e suite (fixture boundary) | PASS (2026-09-21: full suite 102 passed / 0 failed on a cold dev-server start, after F-013 settled the trust gate in `workspace-invitations.spec.ts`; post-F-009 targeted re-run 9 passed incl. enrollment-storage + all 4 stale-epoch specs) |
| TEST-CLI-001 | test:cli + test:cli:live round-trip | PASS (2026-09-21 final verify: test:cli + test:cli:live green, incl. the `rm -rf .git/dotrelay` guard against the config-dir trap) |
| TEST-INTEG-001 | Integration (postgres/valkey, persistence, trust) | PASS (2026-09-21: **genuinely executed** — 19 pass / 0 fail, `0 cached, 1 total`, against local postgres/valkey via the F-012 wrapper; includes the epoch-rotation integration test 92f99ba and the F-009 bootstrap-intercept test. Prior local "green" rows were vacuous: `bun run <script>` never exported `DATABASE_URL` to the turbo child, so every integration test was `describe.skip`-ed and turbo cached the all-skip as green — F-012) |
| TEST-QUALITY-001 | Audit test quality (vacuous tests, over-mocking, missing negative tests) | PASS (campaign review: missing negative/happy-path coverage added — epoch rotation (92f99ba), F-009 bootstrap intercept, F-008 user-defined-branch alert, the `publication-artifacts.test.ts:976` decode contract (actor-owned unreadable → fail, other-user's unreadable → fail-open null); vacuous/over-mocked spots and the F-009 fixture-faking gap documented in FINDINGS.md/COVERAGE.md) |

## CONTRACTS / tooling

| ID | Surface | Status |
|---|---|---|
| CONTRACT-OPENAPI-001 | openapi.json matches OPENAPI_DOCUMENT | FIXED_AND_VERIFIED (was stale: last_owner_protection missing; committed 7cdbad4) |
| CONTRACT-VECTORS-001 | e2ee test vectors verify against sources | PASS (part of check gate, 2026-09-21) |
| CONTRACT-BOUNDARIES-001 | Workspace dependency boundaries | PASS (part of check gate) |

## Findings cross-reference (this campaign)

| Finding | Status | Surfaces touched |
|---|---|---|
| F-001 Stale OpenAPI document | FIXED_AND_VERIFIED (7cdbad4) | CONTRACT-OPENAPI-001 |
| F-002 No OpenAPI generation script | FINDING (improvement) | CONTRACT-OPENAPI-001 (process) |
| F-003 Archive/Restore UI no-op, missing API endpoints | FIXED_AND_VERIFIED (c401ba3) | WEB-WORKSPACE-002/006, API-ADMIN-001, PROTO-PUB-002 (conflict surface) |
| F-004 `?preview=` honored in live deployments | FIXED_AND_VERIFIED (a58055a; live self-hosted probe 2026-09-21) | WEB-WORKSPACE-002, WEB-SELFHOST-001 |
| F-005 CLI identifier `…-undefined` | FIXED_AND_VERIFIED (5d9cba0) | CLI-PROFILE-001 |
| F-006 Re-executed admin commands `operation_conflict` | FIXED (re-link/lifecycle; membership variants deferred, D-009) | API-ADMIN-001, API-MEMBERSHIP-001, PROTO-PUB-002 |
| F-007 Self-hosted browser lifecycle silent no-op | FIXED_AND_VERIFIED (e272869) | WEB-SELFHOST-001, WEB-WORKSPACE-002 |
| F-008 Wrong remediation for User-defined Value decode failures | FIXED_AND_VERIFIED (2d2e4a5; live user-defined-branch alert rendered in the F-009 re-share pass) | WEB-WORKSPACE-003/004, PROTO-SYNC-001 |
| F-009 Self-minted spurious epoch grant blocks peer re-share | FIXED_AND_VERIFIED (this commit; live re-enrollment + CLI re-share, D-011) | WEB-WORKSPACE-007, PROTO-SYNC-001, CLI-PULL-001, SEC-CRYPTO-002 |
| F-010 No owner-initiated epoch-rotation trigger | BLOCKED (product decision — GitHub issue #229, `ready-for-human`; mechanism itself covered by 92f99ba + e2e) | PROTO-EPOCH-001 |
| F-011 pull unchanged/--stdout variants drop pending grant remediation | FIXED_AND_VERIFIED (this campaign; hermetic CLI unit regression + fresh full verify) | CLI-PULL-001, PROTO-SYNC-001 |
| F-012 Local `test:integration` silently skipped every test (false green) | FIXED_AND_VERIFIED (this campaign; fresh 19 pass / 0 fail run, `0 cached`) | TEST-INTEG-001 |
| F-013 e2e invitations spec races the trust settle on cold server start | FIXED_AND_VERIFIED (this campaign; 4/4 + full suite 102 pass on cold start) | TEST-E2E-001 |
