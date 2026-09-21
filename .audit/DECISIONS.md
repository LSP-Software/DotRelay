# DotRelay Audit — Decisions

Assumptions made during the audit so later work can inspect/override them.

---

## D-001 Fresh database policy
- **Assumption:** The audit environment starts from a pristine Postgres with migrations applied via
  `prisma migrate deploy` (not `migrate dev`). This matches a production-ish self-hosted first boot.
- **Rationale:** `.env` points at a local 127.0.0.1 Postgres; `migrate deploy` is the production
  path and is what `db:migrate-check` validates. `migrate dev` would also create a shadow DB and
  possibly drift the schema.
- **Impact:** Any test that needs pre-existing users/teams must seed via sign-in (GitHub OAuth)
  or direct DB inserts.

## D-002 Browser verification without vision
- **Assumption:** The active model cannot consume screenshots, so browser verification is driven via
  `tab.observe()` (ARIA snapshot) + `tab.run(page => page.$eval(...))` text extraction + network
  request logging, not pixel inspection.
- **Rationale:** Screenshots are captured for the record but cannot be visually inspected by this
  model. Text/ARIA + network evidence is sufficient to verify visible behaviour, console errors,
  and failed requests.
- **Impact:** Purely visual regressions (broken layout, misaligned elements) are out of reach for
  this campaign; functional and state behaviour is fully covered.

## D-003 OpenAPI file hand-edit vs. generated
- **Assumption:** The checked-in `packages/contracts/openapi.json` is the source of truth for the
  OpenAPI surface, and it must be hand-kept in sync with `OPENAPI_DOCUMENT` because no generator
  script exists.
- **Rationale:** Adding a generator is a process change beyond the scope of a correctness fix.
- **Impact:** Future protocol-code additions require a manual `openapi.json` update; F-002 records
  the improvement.

## D-004 Dev `.env` is a self-hosted profile
- **Assumption:** The local `.env` (SERVER_PROFILE_ORIGIN=http://localhost:3001, no
  NEXT_PUBLIC_DOTRELAY_WEB_PROFILE) configures a *self-hosted* Server Profile. The web app treats
  its own backend as the profile.
- **Rationale:** `.env.example` documents that the web deployment declares "hosted" at build time;
  an unset var means self-hosted.
- **Impact:** Hosted-specific branches (e.g. hosted web image behaviour) are not exercised by the
  local dev servers; they are inventoried and noted as covered only by build/config inspection.

## D-005 Live-state substitution for the OAuth sign-in round trip
- **Assumption:** Full browser completion of the GitHub OAuth flow is impossible in this
  headless environment (real GitHub credentials required; no relay to a user Chrome session).
- **Substitute:** users A (real GitHub identity 22797936 + real access token, full GitHub
  integration) and B (synthetic identity 99999999) were seeded into Postgres
  (`auth_users`/`auth_accounts`/`auth_sessions`), and every web/API/CLI surface was then
  exercised against the *real* running API with bearer tokens and HMAC-signed
  `better-auth.session_token` cookies (signature = base64 HMAC-SHA256 over the raw session
  token, keyed by `BETTER_AUTH_SECRET`; the browser tab was signed in with the forged cookie,
  which the API accepts identically to a cookie minted by a real OAuth sign-in). The OAuth
  callback code path itself is covered by unit tests (`apps/api/src/index.test.ts`), not by a
  live GitHub round trip.
- **Impact:** Evidence from this campaign is valid for everything downstream of an
  established session (sessions, devices, teams, projects, E2EE, authorizations). The one
  thing it does NOT prove end-to-end is GitHub's own token exchange in the callback handler.

## D-006 `GET /api/v1/teams` requires an active Device
- **Assumption:** The route uses `requireProtocolActor` (session + active Device), so a
  session-only client gets `400 invalid_request`.
- **Rationale:** The web app never calls it (team lists come from the workspace boundary
  catalog); only the CLI calls it, and the CLI always has an enrolled device. Treating
  "list my teams" as a protocol-actor operation is consistent with the rest of the
  administration surface and is not a broken product flow.
- **Impact:** Recorded as acceptable-by-design; no change made. Revisit only if a
  session-only client ever needs team listing.

## D-007 e2e fixture server vs. running dev server
- **Assumption:** `bun run test:e2e` (Playwright) starts/reuses a Next.js dev server with
  `DOTRELAY_WORKSPACE_FIXTURE=1`. A concurrently-running *non-fixture* dev server on :3000
  would make the fixture-mode specs fail.
- **Handling:** before `test:e2e`, the manual `web` hub process is stopped so Playwright's
  own fixture-enabled server is used; the manual process is restarted afterwards for
  browser-driven live verification.
- **Impact:** No code change; purely a sequencing rule for the campaign.

## D-008 `.audit/` ledger is committed with the campaign
- **Assumption:** `bun run verify` includes `tracked-tree:clean`, which fails on any
  untracked file.
- **Handling:** the `.audit/` ledger files are committed as part of the campaign's final
  verification (they are the campaign's evidence record).
- **Impact:** The ledger becomes a permanent repo artifact; acceptable because it is
  explicitly part of the audit deliverable.

## D-009 F-006 fixed on the re-link/lifecycle surface; membership commands deferred
- **Decision:** for F-006, embed the per-execution `operationId` in `commandBytes` on the routes
  whose re-execution the DB layer is proven to support (`project.link`, `environment.create`,
  and the new `projects/:id/lifecycle` + `environments/:id/lifecycle` routes). Do **not** change
  `team.create`/`team.invite`/`membership.change_role`/`membership.remove`/`invitation.accept` in
  this campaign.
- **Rationale:** the DB layer and its integration tests only assert re-link/re-create-after-archive
  (`postgres.integration.test.ts:707-746`); that is the documented, fail-closed product path
  (F-003). The membership/invite/command variants' identical-bytes behaviour is ambiguous: it may
  be *intended* duplicate-command prevention (re-inviting the same subject, or re-issuing an
  already-committed identical role change, is rejected rather than silently re-applied). Deciding
  whether that is a defect or a feature is a product call, so it is recorded (F-006) and filed as a
  GitHub issue instead of changed. This keeps the F-003 root-cause fix surgical and reviewable.
- **Impact:** F-003's fail-closed flow now works end-to-end through the API. If product later says
  membership re-commands must succeed, the same one-field `operationId`-in-bytes fix extends to
  them with no schema or protocol change.

## D-010 Self-hosted browser lifecycle falls back to the verified profile origin
- **Decision:** in a self-hosted deployment that declares no build-inlined API origin, the
  workspace lifecycle handlers (archive/restore project and environment) fall back to the
  Server Profile origin the boundary already verified (`boundary.profile.origin`), exactly as
  the device-bootstrap and key-recovery handlers already do. The membership/invitation
  surfaces keep their documented "skip when no origin is declared" behaviour.
- **Rationale:** the boundary verification is what establishes which server the user is
  talking to; the trusted profile's origin is the only origin the browser is already
  authenticated to, so it is a safe, non-misleading target. Pointing at an unrelated or
  empty origin (the pre-fix silent no-op, F-007) is worse than using the verified one. The
  fallback never targets a server the user has not explicitly trusted.
- **Impact:** self-hosted browser archive/restore now persists instead of silently no-oping
  (F-007). Hosted deployments (which inline an API origin) are unaffected.

## D-011 Newly enrolling Device must not self-mint an epoch grant while a peer holds the real key
- **Decision:** a newly enrolling Device (web browser or CLI) MUST NOT self-mint a
  `CURRENT_PROJECT_EPOCH` grant when any peer Device of the same user already holds a
  `CURRENT_PROJECT_EPOCH` grant for the project's current epoch. Self-mint stays as the only
  way to create the key when no Device holds one (first Device on a fresh project). Gate
  client-side (web enrollment + CLI pull flow); the service keeps accepting validly signed
  self-issued grants.
- **Rationale:** a self-minted grant contains a fresh random key (grant-bootstrap.ts
  `plaintextKey ?? getRandomValues(32)`) that can never decrypt content sealed with the
  publisher's real key, so it is useless to the enrolling Device. It also permanently blocks
  the legitimate repair: `grantsReady` becomes true (a current-epoch grant exists),
  suppressing the pending-grants repair, and `wrapEpochKeyToPeers` skips peers with
  `hasEpochGrant` — so the key-holder's `dotrelay pull` re-share never reaches the Device
  (F-009). The service cannot distinguish a spurious grant from a real one (the grant is
  E2EE-sealed to the recipient; both are validly signed and epoch-consistent), so a server
  rule would either break first-Device bootstrap or require key provenance the protocol does
  not carry. The client knows exactly when it would be minting a key it cannot possibly
  possess (a peer already holds the real one).
- **Impact:** a second Device on an existing project enrolls with no grant; the boundary
  reports `grantsReady: false`, the pending-grants action is offered, and a key-holder's
  `dotrelay pull` provisions the real key to it. Fresh projects (no grants anywhere) are
  unchanged: the first Device self-mints and later peers get provisioned by `pull`. The web
  `repairStaleEpoch` self-mint is deliberately left un-gated: it is only reached when the
  boundary is stale-epoch, and it mints a grant for the *new* epoch (where no peer can hold
  a grant yet), which is the correct first-device recovery; gating it would break in-place
  key recovery after a rotation.
