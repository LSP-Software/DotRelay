# @dotrelay/cli

`@dotrelay/cli` is the public npm selector for the DotRelay standalone CLI. It launches the native
binary for the current platform and forwards the complete argument contract unchanged.
It installs the `dotrelay` command and contains no JavaScript secret client and does not accept portable credentials.

Each native binary ships in its own npm package, `@dotrelay/cli-<platform>-<arch>`, using Node's
`process.platform` and `process.arch` names: `@dotrelay/cli-linux-x64`, `@dotrelay/cli-linux-arm64`,
`@dotrelay/cli-darwin-x64`, `@dotrelay/cli-darwin-arm64`, and `@dotrelay/cli-win32-x64`. The
selector lists all of them as optional dependencies pinned to its own exact version; each declares
`os` and `cpu` (and `libc: glibc` on Linux), so npm installs only the one that matches the machine.
The Linux binaries need glibc; on musl there is no matching package.

In a checkout, run `bun run build`, `bun run package:cli` to stage this machine's binary under
`dist/<platform>-<arch>/`, and `bun run package:cli:npm` to assemble the selector and platform
packages under the repository's `dist/npm/`. `bun scripts/test-cli-package.ts` packs and installs
them and runs `dotrelay --version`.

## Release channels

`@dotrelay/cli@latest` is the stable selector published from release tags; its binary targets no
Server Profile origin, so a new machine starts with `dotrelay setup <origin>`. `@dotrelay/cli@dev`
is rebuilt from the most recent commit on `main` on every push (version
`0.0.0-dev.<commit-sha>`); its binary targets the dev API and, when no Server Profile is
selected, trusts and selects `https://dev-api.dotrelay.dev` on first use.

## Version and launch failures

`dotrelay --version` reports the release version stamped into the native binary when the release
builds it, so it agrees with the tagged/npm release the operator installed. When the selector
cannot launch the binary, it exits with code 1 and reports the release it is running, the
`<platform>-<arch>` this machine needs, and the repair. The platform package can be missing
(installed with `--omit=optional`, or a lockfile made on another platform), unsupported (no
release target, or musl Linux), from another version, not executable, or unlaunchable (for
example built for another architecture). The report lists the platforms the release publishes
and points at `npm install -g @dotrelay/cli@<version>`, the install script, and the GitHub
releases. A `DOTRELAY_BINARY` override that points at a missing or unlaunchable binary is named in
the same report. The selector launches only the binary in the platform package that Node resolves
from its own install, or the absolute path in `DOTRELAY_BINARY`. While the binary runs, the selector forwards `SIGINT`, `SIGTERM`, and
`SIGHUP` to it and re-raises the signal that ended it.
