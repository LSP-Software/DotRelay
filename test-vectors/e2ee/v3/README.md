# DotRelay v3 classical vector corpus

This directory contains the immutable, provider-neutral contract corpus for
`dotrelay-e2ee-v3-classical-webcrypto`.

The v3 suite uses X25519, Ed25519, HKDF-SHA-384, AES-256-GCM, and SHA-384
through standard Web Crypto APIs. It intentionally provides no post-quantum
algorithm, suite negotiation, migration path, fallback provider, or reduced
security mode.

The corpus is generated with:

```sh
bun run vectors:generate
```

The v2 corpus remains available separately as historical material and is not
part of the active v3 protocol.
