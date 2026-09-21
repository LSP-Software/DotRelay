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

## D-012 No owner-initiated epoch-rotation initiator is built
- **Decision:** this campaign does not add a web/CLI trigger for Project epoch key rotation
  (F-010 / GitHub issue #229). The rotation *mechanism* (the protocol `epoch-transitions`
  endpoint + `ProjectEpochRepository.rotate`) is covered and correct; only the human-initiated
  trigger is missing.
- **Rationale:** an initiator must construct and sign `EPOCH_TRANSITION` revision artifacts
  client-side — new E2EE surface with its own failure modes (artifact construction, device-key
  availability, epoch agreement). Choosing the trigger shape (web owner/admin action, a
  `dotrelay rotate` CLI subcommand, or marking rotation as an operator operation) and the
  post-rotation provisioning/re-wrapping semantics is a product decision, not a defect fix.
  Issue #229 records the options.
- **Impact:** a Device stuck without the current epoch key (the F-009 dead end) cannot be
  unstuck by a human through any shipped interface; recovery requires an operator with signing
  tooling. The gap is tracked and blocked on the product decision, not silently treated as a
  bug to fix.

## D-014 `dotrelay admin` is not a user command
- **Assumption:** there is no user-facing `dotrelay admin` subcommand to audit as a distinct
  CLI surface (CLI-ADMIN-001 is NOT_APPLICABLE).
- **Rationale:** `apps/cli/src/args.ts` COMMANDS defines no `admin` group, and
  `apps/cli/src/admin.ts` is the internal `StrictJsonClient` the CLI uses to call the API's
  JSON administration endpoints — not a user-facing command. Membership, invitation, role, and
  removal operations are exercised across the CLI (through `init`/`setup`/`pull`), the API
  routes, and the web workspace surfaces.
- **Impact:** the CLI command surface is inventoried without a spurious `admin` entry;
  membership authorisation is proven via the real surfaces (API-MEMBERSHIP-001, SEC-AUTHZ-003).

## D-020 Live browser mutation pass is infeasible, not skipped
- **Assumption:** the campaign does not perform a live browser *mutation* (add/edit/delete /
  publish/rollback/reveal) on the self-hosted deployment; those flows are covered by the
  Playwright e2e suite on the scripted service.
- **Rationale:** the only live environment with real published content is sealed to the CLI
  publisher Device's per-device user-defined key, so the web editor correctly hides its table
  (residual 2) and there is nothing mutable to exercise live; the only scratch environment is
  left archived, headless, and grant-less. The e2e suite exercises the identical mutation code
  against a scripted boundary, and the live deployment is verified for the read path, alerts,
  History, and CLI-driven real publications.
- **Impact:** browser read/alert/history surfaces are live-verified; browser mutation is
  e2e-verified. No live mutation evidence is claimed.

## D-015 Member key-provisioning / membership-activation is tracked by issue #133, not fixed here
- **Decision:** this campaign does not invent a new endpoint or command to provision a new
  Member's key grants or commit the PENDING_KEY_GRANT→ACTIVE transition (F-014). The gap is
  already tracked as open issue #133 (`ready-for-agent`), whose design was settled 2026-09-17
  into spec #209 (donor re-wrap of the Project epoch key to the Member's Devices,
  owner/admin-authorized, per-Project per-Device grant set, then the existing activation
  transition).
- **Rationale:** choosing the trigger (web owner/admin action, a `dotrelay` CLI subcommand, or
  operator-only documentation) and the cross-User wrapping semantics changes product semantics
  and E2EE surface. The prior campaign's pattern for such gaps (F-010 → #229) is to track
  rather than invent an endpoint. Because #133 already exists and is decision-settled, no
  duplicate issue is filed — the ledger simply records the cross-reference it was missing.
- **Impact:** a PENDING_KEY_GRANT Member is fail-closed (no cross-tenant access; proven live as
  user B). The workflow gap is tracked, not fixed, in this campaign.
