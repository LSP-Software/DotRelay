# DotRelay Audit — Coverage

Evidence record per surface category. "Live" = exercised against the real running
API (:3001) / web (:3000) / CLI / Postgres / Valkey in this campaign (2026-09-21).
"Unit/e2e" = covered by the scripted suites (part of `bun run check` / `bun run verify`).
Residual state that is *intended* behaviour (not a gap) is listed at the end.
Campaign close-out 2026-09-21: the final `bun run verify` (after the last code change)
is green and every INVENTORY.md surface is in a terminal state (PASS / BLOCKED /
NOT_APPLICABLE), with all ten findings resolved or deliberately blocked on product
decisions (F-010 → GitHub issue #229).

## WEB (browser, live self-hosted)
- Sign-out landing, sign-in (OAuth redirect with PKCE + correct scope), session
  persistence, /workspace shell (signed-in and signed-out) — live.
- Zero-teams onboarding (user A after seed; user B) and populated Audit Team state
  (team/project/environment navigation) — live.
- Environment editor read: variable table rendered from the live head (24 lanes: 12
  Variable definitions + 10 Shared Values + 2 User-defined). Live in the F-009 re-share
  pass: after the key-holder CLI re-shared the real epoch key to the re-enrolled browser,
  the editor decrypted the shared lanes and rendered the F-008 user-defined-branch alert
  for the 2 owner-A User-defined Values (sealed to the CLI publisher's per-device key).
- Devices view: per-Device project-access state ("Waiting for project keys" vs "Has
  project access"), CLI setup command, "Set up browser" enrollment. Live (F-009 gate:
  the re-enrolled Device got no self-minted grant).
- Lifecycle archive/restore project + environment via the confirm dialog, persisted
  through the API and flipped only on the service's confirmed reply. Live (F-007 fix
  pass: self-hosted origin fallback).
- Device approval page (/device user_code flow, allow → CLI enrolled). Live (A68CX76M).
- Zero-noise probe (2026-09-21): re-navigated the real environment page with
  console/pageerror/requestfailed/response listeners — 0 console errors, 0 page errors,
  0 failed requests, 0 HTTP >= 400; the sealed-lane alert is present, the variable
  table is deliberately hidden (residual 2), History renders.
- F-004 live verification (a58055a): on the self-hosted (non-fixture) deployment
  `?preview=` no longer forces trusted/active-device state — the real boundary renders
  instead (live probe recorded in FINDINGS.md F-004).
- Sign-out (WEB-AUTH-004): e2e-pinned (workspace-account.spec.ts, desktop + mobile
  menus → /sign-in); the live click was deliberately not performed so the audit's
  single signed-in session survives (D-005 — re-login needs real GitHub OAuth).
- Browser-side publish/draft staging UI (WEB-WORKSPACE-005) and browser
  revision-history/rollback UI (WEB-WORKSPACE-006) close on a live + e2e evidence
  split: the read path, sealed-lane alerts, and the History section render on the real
  deployment (live); add/edit/delete/publish/rollback/reveal are pinned by the e2e
  suite on the scripted service; real publication/rollback/history were proven live via
  the CLI. A live *browser mutation* pass is infeasible, not skipped (D-020): the main
  environment's table is hidden by the correct E2EE residual (residual 2) and the
  scratch environment is archived + headless + grant-less.

## API (live :3001)
- /health, capabilities (ETag + correlationId), teams (401 unauth / 400
  session-without-device / 200 with device) — live.
- Team creation (CLI init → POST /api/v1/teams with Idempotency-Key) — live.
- Better-auth: session (bearer + signed cookie), RFC 8628 device flow end-to-end — live;
  OAuth callback itself unit-only (D-005).
- Membership lifecycle: invite → accept → PENDING_KEY_GRANT → role change → remove →
  post-removal 403 → 409 last_owner_protection — live.
- Project/environment creation + lifecycle (F-003 endpoints), GitHub repository
  resolution via delegated access — live.
- Cross-tenant / direct-ID probes (SEC-AUTHZ): user B (PENDING_KEY_GRANT membership)
  sees an empty team catalog and gets 404 reading A's project by id; unauthenticated
  sync → 401; unknown device header → 403 device_not_active — live (Cookie B isolation).
- Negative/boundary probes (live): wrong media type on sync → 400/415; malformed CBOR
  → 400 invalid_request / invalid_crypto_object (begin); empty body → 400; 70MB body
  → 413 payload_too_large; missing Idempotency-Key on begin → 400; protocol rate limit
  120/60s per-actor → 429 at the 121st request (Retry-After: 60), actor-keyed (user A's
  counter unaffected); better-auth 10/60s limit unit-covered (index.test.ts 11-request
  loop).

## PROTO (live, via CLI + curl)
- Device bootstrap (first device) 201 — live (CLI setup + manual client).
- Device enrollment + approval (CLI setup → browser approval) — live.
- Sync read (pull): decrypts all lanes byte-identical; "No changes found" when in sync — live.
- Publication: genesis publish of 12 variables via begin/stage/finalize — live.
- push (MANIFEST_UPDATE) → new head; pull round-trips the value; rollback (lane-scoped,
  ROLLBACK mutation with rollbackTargetId) → head restored byte-identical; history
  renders 3 revisions with correct mutation types — live (2026-09-21).
- Stale-epoch grant-repair (in-place, un-gated self-mint for the NEW epoch) and
  publication conflict mapping (stale_head/stale_epoch/staging_expired) — unit/e2e
  (workspace-stale-epoch.spec.ts, 4 specs green after the F-009 change).
- Epoch rotation + history trust reset (PROTO-EPOCH-001): the rotation mechanism is
  pinned by the integration test (92f99ba — epoch 1→2 happy path, idempotent replay,
  StaleEpochError, StaleHeadError) plus the 4 stale-epoch e2e specs; live, the
  boundary exposes `epochCurrent`/`rotationRequired` (both healthy on 2026-09-21) and
  the F-009 repair path (un-gated `repairStaleEpoch` self-mint) was live-verified. A
  full live rotation would permanently strand the live browser Devices, so it is not
  run (see Residuals). The owner-initiated rotation trigger is absent — a product
  decision (GitHub issue #229 / F-010), not a defect.
- Full recovery restore happy-path (replacement device via challenge proof) — unit
  covered; not run live for the same device-stranding reason (Residuals).

## CLI (live, DOTRELAY_CONFIG_DIR=/tmp/cli-audit, profile live)
- Pull output contract (F-011, this campaign): every `dotrelay pull` output variant —
  history, diff, file-write, `unchanged`, and `--stdout` JSON — now carries the
  pending grant remediations (`pendingActionsField`), so the F-009 missing-grant
  message can no longer be silently dropped in the in-sync (`No changes found`) or
  `--stdout` case. Pinned by the hermetic CLI unit regression (temp output file,
  Git probe pinned to "outside", two runs: write path then `unchanged: true` run
  asserting the remediation).
- profile add/use/list (trust frame, self-hosted), setup (RFC 8628), init (project+env,
  GitHub resolve), pull, push, rollback, history, device backup/recover — live.
- Recovery kit: backup wrote a generation-2 kit (envelope b22891be, sealed under the
  active device's key, file never printed); with device bundles wiped, `device recover`
  correctly FAIL-CLOSED with `recovery_requires_no_active_device` (recovery mints a
  replacement Device, so it is blocked while any of the user's Devices is active).
  Restored bundles; pull still decrypted all 12 values (device intact). 9 recovery
  unit tests (backup, rotation/retirement naming, challenge-proof restore, in-flight
  resume, replacement activation) pass against the scripted service.
- build: `bun --cwd apps/cli run build` → working 81MB dist/dotrelay binary, exercised.
- `dotrelay admin` subcommands (CLI-ADMIN-001): NOT_APPLICABLE (D-014) — no such
  command exists in the code or docs; membership operations are proven across the
  CLI/API/WEB surfaces above.

## SEC (live)
- Values never stored in plaintext: the live head's lane columns are ciphertext; the
  pull decrypts client-side (E2EE). Verified by the byte-identical pull + the DB lane
  columns being ciphertext (SEC-CRYPTO-001/002 live via the F-009/F-008 passes).
- No secret/key leak in API stdout: the full API log buffer (structured
  `api.request.completed` events only) was scanned in-process for BETTER_AUTH_SECRET,
  GITHUB_CLIENT_SECRET, DATABASE_URL/VALKEY_URL + embedded passwords, and the audit
  bearer/session cookies — none present (SEC-LEAK-001 live).
- Cross-device / cross-user secret isolation: user B cannot read A's lanes (no grant,
  no membership); an unknown Device gets 403 (SEC-LEAK-002 live via Cookie B + probes).
- Cookie scoping (SEC-COOKIE-001): live `page.cookies()` probe (2026-09-21) —
  `better-auth.session_token` scoped to the API host, path `/`, session cookie,
  `secure: false` on plain-HTTP dev (correct: `useSecureCookies =
  profile.isProduction`, auth.ts); production flags unit-pinned (apps/api/src/
  index.test.ts:458 Secure + SameSite=Lax + HttpOnly, :504-538 parent-domain scoping
  for split web/api origins, :241 Origin required on cookie state changes).

## DB
- db:validate + db:migrate-check green in the final verify against the deployed
  migration history on the live compose Postgres (DB-SCHEMA-001; DB-MIGRATE-001: all
  9 migrations applied on the fresh DB 2026-09-21, then the whole campaign ran on it).
- Hardened constraints (DB-CONSTRAINT-001): live 409 last_owner_protection on owner
  removal; `grant_objects` is immutable — the F-009 spurious row `01a055d2` is
  permanently undeletable (a live DELETE was rejected "immutable DotRelay row" by
  `dotrelay_reject_immutable_row`); admin invariants unit/integration-covered.
- Sensitive columns (DB-SENSITIVE-001): lane value columns store ciphertext +
  `ciphertextHash` only (no plaintext column exists on `lane_objects`); epoch keys are
  wrapped per recipient in `grant_objects` ciphertext; no plaintext values or key
  material in the DB or in API logs/observability events (SEC-CRYPTO/SEC-LEAK live).

## CFG / deployment
- Env validation (CFG-ENV-001): `loadServerProfileConfig` fail-fast (profile.ts:122-248
  — production requires SERVER_PROFILE_ID / BETTER_AUTH_SECRET >= 32 / the GITHUB
  pair; a trust-proxy list is required when the flag is on) unit-pinned
  (profile.test.ts:33,148-238); the self-hosted `.env` is what api + web ran on all
  campaign.
- Trust proxy (CFG-TRUSTPROXY-001): first-entry X-Forwarded-Proto trust
  (profile.ts:326-338) + flag/CIDR parsing (:158-170) + better-auth
  ipAddressHeaders/trustedProxies wiring (auth.ts:44-47); unit-pinned
  (profile.test.ts:148-211 edge-hop trust, `http,https` veto, untrusted-proxy
  rejection; observability.test.ts:133-145 client-IP from header); the dev deployment
  runs without a front proxy, so the production case is unit-covered.
- Rebind (CFG-REBIND-001): SERVER_PROFILE_REBIND → `profile.allowRebind`
  (profile.ts:171) persisted via `ensureServerProfile` (index.ts:1145-1149;
  fail-closed origin-diff test in server-profile.test.ts); the client rebind flow is
  `planContextSwitch` (environment-context.ts:64-67 + unit tests) and e2e
  (workspace-history.spec.ts:275,314 prompt/restore/discard); the self-hosted profile
  itself is a rebind off the hosted default and was switched live.
- Deployment (CFG-DEPLOY-001): both Docker images built from the repo on 2026-09-21
  (api exit=0 in 204s, web exit=0 in 138s; logs /tmp/docker-{api,web}-build.log) —
  api image: bun build + `prisma migrate deploy` entrypoint + non-root + curl
  healthcheck, web image: Next standalone with baked NEXT_PUBLIC_*; compose
  postgres/valkey ran the whole campaign; CI `deploy-dev` (ci.yml:175-223) builds +
  pushes both images, deploys via Coolify, and runs a capabilities smoke.
- CI (CFG-CI-001): ci.yml jobs map 1:1 onto the local `bun run verify` chain
  (check→check, build-smoke→build+smoke, unit→test:unit, integration→test:integration
  with pinned postgres/valkey images, browser-e2e→test:e2e, e2e-full→
  test:e2e:full on pinned postgres/valkey service containers, cli-round-trip→
  test:cli+test:cli:live on a 3-OS matrix, prisma→db:validate+db:migrate-check with a
  shadow DB, docs→docs:validate); every local equivalent is green in the campaign's
  verify runs. The `e2e-full` job (PR #228) drives the packaged CLI binary through
  the complete operator flow — setup (real device authorization), init, push, pull,
  diff, refusal, history + rollback, TTY stdout safety, status, logout + re-login —
  against a real in-process API on a throwaway migrated Postgres database with real
  Valkey rate limits, demo data only (GitHub stubbed via the `githubFetch` DI seam);
  it runs on every PR and gates `deploy-dev`/`build-cli-dev` and, in release.yml,
  gates `build-images`/`build-cli` so prod images and the published CLI cannot ship
  until the full flow passes. CI-only deltas: the `security` job (`bun run
  security:audit` = `bun audit`) has no local verify step — it passes locally (no
  vulnerabilities, 590 packages checked) — and the npm publish step requires the
  `NPM_TOKEN` registry secret.
- CLI deployment (CFG-CLI-DEPLOY-001): `package:cli` produced the working 81MB
  `dist/dotrelay` binary, exercised live all campaign (CLI-BUILD-001); ci.yml
  build-cli-dev (3-OS) + publish-cli-dev (npm `--tag dev`) verified by inspection —
  the publish step requires the `NPM_TOKEN` registry secret, so the npm publish itself
  is a CI-only delta recorded here, not a defect.

## TEST
- check gate (format/lint/typecheck/boundaries/openapi/vectors/unit) and production
  builds green (TEST-UNIT-001 / TEST-BUILD-001).
- Playwright suite: 101 passed mid-campaign; the campaign's final verify re-ran the
  whole suite — 102 passed / 0 failed on a cold dev-server start, after F-013 settled
  the trust gate in the invitations spec (TEST-E2E-001).
- test:cli + test:cli:live green in the final verify (TEST-CLI-001, including the
  `rm -rf .git/dotrelay` guard against the live profile's config-dir trap).
- test:integration (TEST-INTEG-001) genuinely executed in the final verify: 19 pass /
  0 fail, `0 cached, 1 total`, against local postgres/valkey, including the new
  epoch-rotation test 92f99ba and the F-009 bootstrap-intercept test. **Correction
  (F-012):** every earlier local "test:integration green" was vacuous — `bun run
  <script>` loads `.env` in-process only and never exported `DATABASE_URL` to the
  `turbo` child, so the suites' `describe.skip` gate skipped the entire stage and
  turbo cached that all-skip as green (23 skip / 0 pass in each local verify log);
  only CI (job-level env) and the one-off direct runs (e.g. /tmp/integration.txt,
  which is what actually validated 92f99ba at the time) ever executed the tests. The
  `scripts/test-integration.ts` wrapper loads `.env`, fails fast on a missing URL,
  verifies both services, and spawns turbo with the full environment, so a broken
  environment can no longer degrade to a silent all-skip.
- Final-verify hygiene (this campaign): an earlier closeout verify showed a turbo-cache
  false green — `@dotrelay/cli#test:unit` was replayed from cache while the F-009 test
  was non-hermetic (its pass depended on whether a leftover gitignored `apps/cli/.env`
  existed, which selected between pull's write path and its `unchanged` path; the
  latter dropped the remediation — F-011). The F-009 test is now hermetic (temp output
  + pinned Git probe) and the campaign's final verify invalidates the turbo cache so
  `@dotrelay/cli#test:unit` is re-executed, not replayed; that fresh run is green
  (TEST-CLI-001 / TEST-UNIT-001).
- Quality pass (TEST-QUALITY-001): missing coverage added during the campaign —
  epoch rotation (92f99ba), the F-009 bootstrap intercept, the F-008 user-defined
  branch alert, and the decode contract pinned at publication-artifacts.test.ts:976
  (actor-owned unreadable User-defined Value → decode fails; another user's unreadable
  value fails open as null). Vacuous/over-mocked spots and the F-009 fixture-faking
  gap (why the suites missed it) are documented in FINDINGS.md.

## Residuals (intended behaviour — not gaps, do not scrub)
1. **Append-only grant log.** `grant_objects` is immutable (trigger
   `dotrelay_reject_immutable_row` rejects UPDATE/DELETE). The F-009 spurious
   self-minted grant row `01a055d2` (stuck browser Device `40a0a545`) is therefore
   permanent. The stuck Device is unrecoverable at epoch 1 (the key-holder's
   `wrapEpochKeyToPeers` skips already-granted peers and the spurious row cannot be
   deleted); recovery for it needs an epoch rotation + re-publish. This is the F-009
   dead-end — now prevented for every future enrollment by the client-side gate (D-011).
2. **E2EE residual for User-defined Values.** Owner-A's 2 User-defined Values stay
   sealed to the CLI publisher Device's per-device key and are NOT readable by any other
   Device (including a browser that holds the project epoch key). `dotrelay pull`
   re-shares the *project epoch* key only, never user-defined keys. The web editor
   surfaces the correct re-publish/device-recover remedy (F-008). Correct by design.
   Re-probed 2026-09-21 (zero-noise pass): the resulting live page state — sealed-lane
   alert, hidden variable table, rendered History — is exactly the pinned fail-closed
   contract (`decodeSyncManifest` folds the verified page; actor-owned unreadable
   lanes are REQUIRED → UnreadableLaneError, pinned at
   publication-artifacts.test.ts:976, while other users' unreadable values stay null —
   fail-open — at :935). Boundary healthy, CLI in sync, 0 console errors / failed
   requests. Only re-publishing those two values from the CLI device (or `dotrelay
   device recover`) restores the table on other devices.
3. **Live env head is a rollback revision.** The audit's push→rollback left the
   environment head at the lane-scoped rollback revision `189320f0` (values identical
   to the genesis revision). Append-only rollback semantics — correct, not a defect.
4. **User B's PENDING_KEY_GRANT membership is hidden by the web catalog** (it lists
   ACTIVE memberships only), so B sees "No teams yet" and no pending-invitation banner.
   The behaviour is fail-closed (B cannot reach A's data); whether to surface a
   pending-key-grant/pending-invitation affordance is a product decision, not a defect.
5. **OAuth callback round trip** is unit-covered, not live (real GitHub credentials
   required, D-005). Everything downstream of an established session is live-verified.
6. **No owner-initiated epoch-rotation trigger exists** (F-010, GitHub issue #229,
   `ready-for-human`): rotation is reachable through the protocol path (the F-009
   repair self-mint) but there is no owner/UI trigger; adding one is a product
   decision. The rotation mechanism itself is covered (92f99ba + e2e).
7. **Live browser mutation pass infeasible** (D-020): the only live environment's
   table is hidden by residual 2, and the scratch environment
   (`c427bdb5`/`388e8090`) is left archived + headless + grant-less. Editor
   add/edit/delete/publish/rollback/reveal are covered by the e2e suite on the
   scripted service; the live surfaces cover read path, alerts, History, and
   CLI-driven real publications.
