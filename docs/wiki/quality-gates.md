# Quality gates

The fast gate runs formatting, linting, strict TypeScript checks, workspace-boundary checks,
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

The packaged CLI job also runs `bun run test:cli:live` on Linux, macOS, and Windows. It starts a
short-lived HTTP Server Profile fixture and drives the compiled binary through profile pinning,
first-Device bootstrap, dual-control enrollment, Recovery Code backup, simulated Device
loss, and AMK recovery from the Recovery Code. The test uses the CLI's local file credential
store in an isolated state directory on every runner.

CI runs the slower gates as independent required jobs in parallel and cancels superseded runs.
Coverage is a review signal rather than a merge threshold; product tickets should report percentage
and absolute covered-line changes against the base commit. A clean checkout must remain clean after
every read-only gate.

Workspace rules are enforced by `bun run boundaries`: applications cannot import applications,
packages cannot import applications, all workspace dependencies use `workspace:*`, package imports
use public exports, undeclared imports and cycles are rejected, and runtime-neutral packages may
not use browser-only or server-only facilities.

The repository uses Bun's built-in `bun fmt` and `bun lint` as its formatter and linter. ESLint and
Prettier are not part of the toolchain. Everything else builds, tests and ships on the pinned
stable Bun release. The built-in linter is not in stable releases yet, so `scripts/setup-bun.py`
also installs a pinned canary, and `bun run lint` runs only `bun lint` with it (found through
`DOTRELAY_LINT_BUN` or beside the stable toolchain).

The required security gate is `bun run security:audit`; CI and the release workflow's verify job
run it with network access to the Bun advisory service. Dependency updates are never auto-merged.
