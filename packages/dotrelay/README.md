# dotrelay npm selector

This package is the public npm selector for the DotRelay standalone CLI. It chooses the native
binary staged for the current platform and forwards the complete argument contract unchanged.
It contains no JavaScript secret client and does not accept portable credentials.

The release package must include a native binary under `dist/<platform>-<arch>/`. In a checkout,
run `bun run build` followed by `bun run package:cli` to stage the current platform binary before
testing or packing the package. `npx dotrelay --help` then uses the same command contract as the
standalone binary.
