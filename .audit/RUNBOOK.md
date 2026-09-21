# DotRelay Audit Runbook

Working commands and environment procedures discovered during the audit.

## Services

| Service | How to start | Notes |
|---|---|---|
| Postgres 17 | `docker compose up -d postgres` (or already on 127.0.0.1:5432) | db `dotrelay`, user `dotrelay`/`dotrelay`; shadow db `dotrelay_shadow` |
| Valkey 8 | `docker compose up -d valkey` | redis protocol on 127.0.0.1:6379 |
| API (Hono) | `hub start api` → `bun --env-file=../../.env run src/index.ts` in `apps/api` | listens on :3001, readiness log `listening` |
| Web (Next dev) | `hub start web` → `npx next dev -p 3000 -H 127.0.0.1` in `apps/web` | :3000 |

## Database lifecycle (fresh checkout)

```
cd packages/database
bun x prisma migrate deploy --config prisma.config.ts   # apply all migrations
```
API crashes on boot without migrations (`TableDoesNotExist` on `server_profiles`).
`bun x prisma generate --config prisma.config.ts` for the client (runs on postinstall).

## Key URLs

- Web: http://localhost:3000 (sign-in at /sign-in, device approval under /device, workspace under /workspace)
- API: http://localhost:3001 (`/health` = `{"status":"ok"}`, better-auth under /api/auth/*, protocol under /api/protocol/*)
- Server profile id `00000000-0000-4000-8000-000000000001`, origin http://localhost:3001 (hosted=false in dev .env → self-hosted profile)

## Verification commands (repo root)

- `bun run check` → format:check + lint + typecheck + boundaries + openapi:check + vectors:verify-sources + test:unit
- `bun run build` → turbo build (web next build, api bun build, cli bun)
- `bun run smoke` → turbo smoke (smoke-api.ts / smoke-web.ts / smoke-cli.ts)
- `bun run test:integration` → scripts/test-services.ts + per-package (postgres integration, trust integration)
- `bun run test:e2e` → playwright (apps/web/e2e)
- `bun run test:cli` → apps/cli harness; `bun run test:cli:live` → scripts/test-cli-live.ts
- `bun run db:validate`, `bun run db:migrate-check`, `bun run docs:validate`, `bun run tracked-tree:clean`
- `bun run verify` → all of the above in order

## GitHub OAuth

.env has real GITHUB_CLIENT_ID/SECRET registered for this machine. OAuth callback path:
http://localhost:3001/api/auth/callback/github (see .env.example comment).
GitHub integration is used for identity + delegated repository access (fine-grained).

## Browser testing

Use managed Chromium via the browser tool against http://localhost:3000.
Watch console + failed network requests on every flow.

## Caveats

- Fresh audit DB starts with no users/teams. Account state must be built by sign-in (GitHub OAuth)
  or by direct DB seeding when testing server-side paths.
- `run-issues.sh` / `scripts/run-issues-panel.ts` are dev tooling (issue grilling), not product surface —
  still inventoried for completeness.
- `test-vectors/e2ee` pins the crypto suite; `bun run vectors:verify-sources` re-derives them.
