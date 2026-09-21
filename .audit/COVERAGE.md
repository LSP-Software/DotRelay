# DotRelay Audit — Coverage

Evidence record per surface category. "Live" = exercised against the real running
API (:3001) / web (:3000) / CLI / Postgres / Valkey in this campaign (2026-09-21).
"Unit/e2e" = covered by the scripted suites (part of `bun run check` / `bun run verify`).
Residual state that is *intended* behaviour (not a gap) is listed at the end.

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
- Not covered by a *live UI* pass (unit/e2e only, noted in INVENTORY.md): browser-side
  publish/draft staging UI (WEB-WORKSPACE-005) and revision-history UI in the browser
  (WEB-WORKSPACE-006) — the underlying protocol is live-covered via the CLI (below) and
  by the e2e suite.

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
- Epoch rotation + history trust reset (PROTO-EPOCH-001) and full recovery restore
  happy-path (replacement device via challenge proof) — unit/e2e covered; NOT run live
  (an epoch-2 rotation / device replacement would permanently strand the live browser
  Devices and is destructive to the live state; see Residuals).

## CLI (live, DOTRELAY_CONFIG_DIR=/tmp/cli-audit, profile live)
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

## DB / CFG / TEST
- db:validate + migrate deploy (all 9 migrations on a fresh DB) — PASS (DB-MIGRATE-001).
- check gate (format/lint/typecheck/boundaries/openapi/vectors/unit) green; the full
  Playwright suite (101) plus the 9 targeted specs (enrollment-storage incl. the new
  F-009 regression, and all 4 stale-epoch specs) green after the F-009 change. The
  campaign's final `bun run verify` (incl. e2e + tracked-tree:clean) is the last gate.

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
3. **Live env head is a rollback revision.** The audit's push→rollback left the
   environment head at the lane-scoped rollback revision `189320f0` (values identical
   to the genesis revision). Append-only rollback semantics — correct, not a defect.
4. **User B's PENDING_KEY_GRANT membership is hidden by the web catalog** (it lists
   ACTIVE memberships only), so B sees "No teams yet" and no pending-invitation banner.
   The behaviour is fail-closed (B cannot reach A's data); whether to surface a
   pending-key-grant/pending-invitation affordance is a product decision, not a defect.
5. **OAuth callback round trip** is unit-covered, not live (real GitHub credentials
   required, D-005). Everything downstream of an established session is live-verified.
