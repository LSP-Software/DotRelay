# Quality gates

The fast gate runs formatting, Biome linting, strict TypeScript checks, workspace-boundary checks,
the checked OpenAPI output comparison, and unit tests:

```sh
bun run check
```

The contract package's focused checks can also be run directly:

```sh
bun run openapi:check
bun test packages/contracts/src/index.test.ts scripts/contracts-vectors.test.ts
```

The full gate adds production-shaped builds and smoke tests, PostgreSQL/Valkey integration,
browser end-to-end tests, packaged CLI round trips, Prisma schema and migration checks, and Wiki
documentation validation:

```sh
bun run verify
```

CI runs the slower gates as independent required jobs in parallel and cancels superseded runs.
Coverage is a review signal rather than a merge threshold; product tickets should report percentage
and absolute covered-line changes against the base commit. A clean checkout must remain clean after
every read-only gate.

Workspace rules are enforced by `bun run boundaries`: applications cannot import applications,
packages cannot import applications, all workspace dependencies use `workspace:*`, package imports
use public exports, undeclared imports and cycles are rejected, and runtime-neutral packages may
not use browser-only or server-only facilities.

The repository uses Biome as its sole formatter and linter. ESLint and Prettier are not part of the
toolchain.

The required security gate is `bun run security:audit`; CI runs it with network access to the Bun
advisory service. Dependency updates are never auto-merged.
