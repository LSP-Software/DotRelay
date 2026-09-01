# dotrelay npm selector

This package is the `npx dotrelay` entrypoint. It selects the packaged native Bun binary for the
current platform and forwards the complete argument contract unchanged. It contains no JavaScript
secret client and does not accept portable credentials. Release packaging places binaries under
`dist/<platform>-<architecture>/dotrelay`.
