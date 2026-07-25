# DotRelay

DotRelay is a Bun/Turborepo monorepo. The initial foundation contains the Next.js web app, Hono
API, and standalone Bun-compiled CLI under `apps/`.

Run `bun install --frozen-lockfile`, then `bun run check` for the fast read-only gate or
`bun run verify` for the full pull-request-equivalent suite. Repository commands, dependency and
boundary rules, CI checks, release policy, and the canonical Wiki source are documented in
[`docs/wiki/`](docs/wiki/README.md).
