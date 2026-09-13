# dotrelay npm selector

This package is the public npm selector for the DotRelay standalone CLI. It chooses the native
binary staged for the current platform and forwards the complete argument contract unchanged.
It contains no JavaScript secret client and does not accept portable credentials.

The release package must include a native binary under `dist/<platform>-<arch>/`. In a checkout,
run `bun run build` followed by `bun run package:cli` to stage the current platform binary before
testing or packing the package. `npx dotrelay --help` then uses the same command contract as the
standalone binary.

## Version and launch failures

`dotrelay --version` reports the release version stamped into the native binary when the release
builds it, so it agrees with the tagged/npm release the operator installed. When the selector
cannot launch the binary — it is missing for this machine's platform and architecture, present
but not executable, or unlaunchable (for example built for another architecture) — it exits
with code 1 and reports the release it is running, the `<platform>-<arch>` this machine needs,
the platforms the package ships, and the supported repair: reinstall this release or the latest
from npm (`npm install -g dotrelay@<version>`, `npm install -g dotrelay@latest`) or run the
matching native binary from a DotRelay GitHub release. A `DOTRELAY_BINARY` override that points
at a missing or unlaunchable binary is named in the same report.
