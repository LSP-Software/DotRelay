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
| WEB-AUTH-004 | Logout (browser device revocation) | UNTESTED |
| WEB-WORKSPACE-001 | /workspace signed-out redirect behaviour | PASS (live: signed-out shell renders; signed-in shell renders real "No teams yet" onboarding after seed) |
| WEB-WORKSPACE-002 | Workspace shell: team switcher, project list, environment list | PASS (live 2026-09-21: zero-teams onboarding and populated Audit Team state both rendered; team/project/environment navigation exercised in the F-007/F-009 live passes) |
| WEB-WORKSPACE-003 | Environment page: variable table, add/edit/delete variable | IN_PROGRESS (live: variable table read verified in the F-009 re-share pass — 24 head lanes incl. 2 User-defined; add/edit/delete mutation pass pending) |
| WEB-WORKSPACE-004 | Shared vs user-defined variable display (masking/reveal) | IN_PROGRESS (live: shared vs User-defined lane distinction visible in the editor incl. the F-008 sealed-lane alert; masking/reveal interaction pending) |
| WEB-WORKSPACE-005 | Publish/draft flow in browser (staged lanes, reconciliation, conflicts) | UNTESTED (publication proven via CLI; browser publish pending) |
| WEB-WORKSPACE-006 | Revision history + rollback in browser | IN_PROGRESS (CLI `history`/`rollback` pending with the CLI round-trip pass; browser surface pending) |
| WEB-WORKSPACE-007 | Devices tab: enrolled devices, CLI setup command, approval | PASS (live 2026-09-21: approval flow A68CX76M; Devices view lists This browser / CLI / browser devices with per-Device project-access state incl. "Waiting for project keys" vs "Has project access") |
| WEB-WORKSPACE-008 | Team administration: members, invitations, role change, removal, last-owner protection | PASS (API-level live: full lifecycle incl. 409 last_owner_protection; web UI pass pending) |
| WEB-WORKSPACE-009 | Project creation / deletion / GitHub repository connection | PASS (live: project+environment created via CLI `init` with real GitHub repository resolution; docs state project creation is CLI-only in the web app) |
| WEB-DEVICE-001 | /device approval page: user_code flow, allow/deny | PASS (live: code A68CX76M rendered, "Allow this CLI" approved, CLI completed enrollment, "Allowed" confirmation shown) |
| WEB-ERR-001 | Error/loading states, offline behaviour, stale epoch UI | UNTESTED |
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
| API-CORS-001 | CORS/origin/cookie trust boundaries (web origin allowlist, no mixed creds) | IN_PROGRESS (web↔API cross-origin credentials flow works live; negative origin cases pending) |

## PROTO — protocol state machine

| ID | Surface | Status |
|---|---|---|
| PROTO-BOOT-001 | Device bootstrap (first device per user) | PASS (live: CLI + manual client bootstrap both 201, devices ACTIVE) |
| PROTO-ENROLL-001 | Device enrollment + approval (CLI setup) | PASS (live: `dotrelay setup` → browser approval → "Signed in to live. Device enrolled.") |
| PROTO-SYNC-001 | Environment sync read (pull): revisions, values, signing trust | PASS (live: `dotrelay pull` decrypted 12 values to .env, byte-identical to published values) |
| PROTO-PUB-001 | Publication: staged lanes, expected head, three-way reconciliation | PASS (live: genesis publish of 12 variables (10 shared + 2 user-defined) via begin/stage/finalize) |
| PROTO-PUB-002 | Conflicts: variable conflict, stale_head, stale_epoch, staging_expired | IN_PROGRESS (stale epoch grant-repair path unit-covered; live conflict reproduction pending) |
| PROTO-EPOCH-001 | Epoch rotation, history trust reset | IN_PROGRESS (grant bootstrap endpoint live-verified shape; rotation reproduction pending) |
| PROTO-RECOVERY-001 | Recovery kit: active/pending, rotation, device replacement | IN_PROGRESS (endpoint shapes read; live kit/restore round trip pending) |
| PROTO-SIGN-001 | Revision signature verification (team signing devices, membership windows) | IN_PROGRESS (CLI `history`/`rollback` pending) |
| PROTO-RATE-001 | Rate limits (device polling, endpoint limits) | IN_PROGRESS (limits configured in profile; live threshold probes pending) |

## CLI

| ID | Surface | Status |
|---|---|---|
| CLI-SETUP-001 | `dotrelay setup` (device enrollment via browser approval) | PASS (live against real API: profile add trust prompt, RFC 8628 code, browser approval, completion) |
| CLI-PULL-001 | `dotrelay pull` / sync to .env (merge, new vars, missing user-defined) | PASS (live: decrypts all lanes, replaces .env, retains .env.previous, "No changes found" when in sync) |
| CLI-PUBLISH-001 | publish flow (draft, conflicts, reconciliation) | PASS (live: `dotrelay init` genesis publish, 12 vars, review gate, "Encrypted 12 Variables / Uploaded / Published") |
| CLI-PROFILE-001 | Server profile selection / config (hosted vs self-hosted URL) | PASS (live: profile add/use/list against self-hosted; trust-frame `…-undefined` abbreviation bug fixed this campaign, see F-005) |
| CLI-ERROR-001 | Error recovery (offline, 401, stale epoch, network failure) | IN_PROGRESS |
| CLI-AUTH-001 | CLI credentials storage, recovery kit | IN_PROGRESS (wrapped device bundles + credential store verified on disk; recovery round trip pending) |
| CLI-ADMIN-001 | `dotrelay admin` subcommands | IN_PROGRESS (membership ops proven at API level; CLI wrappers pending) |
| CLI-BUILD-001 | CLI packaging (build-cli, npm package, cross-OS binaries) | PASS (live: `bun --cwd apps/cli run build` produced working 81MB `dist/dotrelay` binary, exercised fully) |

## SEC — authorization / crypto / sensitive data

| ID | Surface | Status |
|---|---|---|
| SEC-AUTHZ-001 | Cross-tenant IDOR via direct IDs (teams/projects/envs/devices/memberships) | UNTESTED |
| SEC-AUTHZ-002 | Unauthenticated access to all domain endpoints | IN_PROGRESS (401/404 confirmed on spot probes) |
| SEC-AUTHZ-003 | Member vs admin vs owner privilege boundaries | UNTESTED |
| SEC-AUTHZ-004 | Authorization after membership removal (windows, signing devices) | UNTESTED |
| SEC-CRYPTO-001 | E2E encryption: values never stored in plaintext (DB columns) | UNTESTED |
| SEC-CRYPTO-002 | Key material boundaries (who can decrypt shared vs user-defined) | UNTESTED |
| SEC-LEAK-001 | No secret/key leak in logs (API stdout, observability events) | UNTESTED |
| SEC-LEAK-002 | No secret leak to unauthorized clients (cross-device, cross-user sync pages) | UNTESTED |
| SEC-OBS-001 | Diagnostic event allowlist / redaction / correlation IDs | UNTESTED |
| SEC-COOKIE-001 | Cookie scoping (secure flag, parent-domain scoping, origin binding) | UNTESTED |

## DB — schema / migrations

| ID | Surface | Status |
|---|---|---|
| DB-SCHEMA-001 | Prisma schema vs production (db:validate) | UNTESTED |
| DB-MIGRATE-001 | Migrations deploy cleanly on fresh DB | PASS (migrate deploy applied all 9 on fresh DB 2026-09-21) |
| DB-CONSTRAINT-001 | Hardened constraints (last-owner, admin invariants, observability) | UNTESTED |
| DB-SENSITIVE-001 | Sensitive column inventory (ciphertext, keys, tokens) | UNTESTED |

## CFG — configuration / deployment

| ID | Surface | Status |
|---|---|---|
| CFG-ENV-001 | Env var validation/fail-fast on missing/invalid config | UNTESTED |
| CFG-TRUSTPROXY-001 | TRUST_PROXY / trusted proxies / X-Forwarded-Proto behaviour | UNTESTED |
| CFG-REBIND-001 | SERVER_PROFILE_REBIND origin change flow | UNTESTED |
| CFG-DEPLOY-001 | Docker images (api/web) build + self-hosted compose | UNTESTED |
| CFG-CI-001 | CI workflow jobs (check/build/unit/integration/e2e/cli/prisma/docs/security) | UNTESTED |
| CFG-CLI-DEPLOY-001 | CLI dev packaging + npm dev publish | UNTESTED |

## TEST — test suite quality

| ID | Surface | Status |
|---|---|---|
| TEST-UNIT-001 | All unit suites pass (check gate) | PASS (2026-09-21: check exit 0) |
| TEST-BUILD-001 | Production builds pass (web/api/cli) | PASS (2026-09-21: build exit 0) |
| TEST-E2E-001 | Playwright e2e suite (fixture boundary) | PASS (2026-09-21: full suite 101 passed; post-F-009 targeted re-run 9 passed incl. enrollment-storage + all 4 stale-epoch specs; full re-run in the campaign's final `bun run verify`) |
| TEST-CLI-001 | test:cli + test:cli:live round-trip | UNTESTED |
| TEST-INTEG-001 | Integration (postgres/valkey, persistence, trust) | UNTESTED |
| TEST-QUALITY-001 | Audit test quality (vacuous tests, over-mocking, missing negative tests) | UNTESTED |

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
| F-004 `?preview=` honored in live deployments | OPEN (verified 2026-09-21) | WEB-WORKSPACE-002, WEB-SELFHOST-001 |
| F-005 CLI identifier `…-undefined` | FIXED_AND_VERIFIED (5d9cba0) | CLI-PROFILE-001 |
| F-006 Re-executed admin commands `operation_conflict` | FIXED (re-link/lifecycle; membership variants deferred, D-009) | API-ADMIN-001, API-MEMBERSHIP-001, PROTO-PUB-002 |
| F-007 Self-hosted browser lifecycle silent no-op | FIXED_AND_VERIFIED (e272869) | WEB-SELFHOST-001, WEB-WORKSPACE-002 |
| F-008 Wrong remediation for User-defined Value decode failures | FIXED_AND_VERIFIED (2d2e4a5; live user-defined-branch alert rendered in the F-009 re-share pass) | WEB-WORKSPACE-003/004, PROTO-SYNC-001 |
| F-009 Self-minted spurious epoch grant blocks peer re-share | FIXED_AND_VERIFIED (this commit; live re-enrollment + CLI re-share, D-011) | WEB-WORKSPACE-007, PROTO-SYNC-001, CLI-PULL-001, SEC-CRYPTO-002 |
