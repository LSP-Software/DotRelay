# Development

DotRelay is a Bun/Turborepo monorepo with three applications:

- `apps/web` is the Next.js browser surface.
- `apps/api` is the independent Hono API and Prisma owner.
- `apps/cli` is the standalone Bun-compiled CLI.

Run `bun install --frozen-lockfile` after checking out the repository. Use `bun run dev` for local
development, `bun run check` for the fast read-only gate, and `bun run verify` for the complete
pull-request-equivalent suite.

Use `bun run format:fix` and `bun run lint:fix` for explicit mutations. The read-only format and
lint commands never rewrite files.

New dependencies must be installed with Bun at the latest available version. Do not hand-enter a
version or copy one from another manifest. Commit the resulting text `bun.lock`.

The service-backed gates use the local PostgreSQL and Valkey services from `compose.yaml`:

```sh
docker compose up -d postgres valkey
bun run test:integration
bun run db:migrate-check
docker compose down
```
