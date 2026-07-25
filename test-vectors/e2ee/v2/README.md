# Immutable `dotrelay-e2ee-v2` vectors

This directory is a checked-in, immutable contract corpus. `primitives.json` contains the exact
deterministic-CBOR boundary, domain-separator, hash, and fixed-length fixtures. `objects.json` contains the exact
canonical and unsigned-body CBOR bytes for every closed object kind. `positive.json` records the
object, enum, and conditional coverage, `negative.json` records malformed bytes and coarse errors,
and `browser-bun.json` carries the same wire bytes for cross-runtime fixtures. The executable
fixture source in `scripts/vector-fixtures.ts` independently reconstructs the registry cases, and
the tests compare its output with this frozen corpus.

The corpus is intentionally cryptographic-provider neutral. It covers the codec and wire boundary;
provider ACVP/RFC primitive vectors and provider integration belong to the later provider ticket.
No fixture contains human-readable Environment or Variable names, descriptions, classifications, or
Values. It describes only the v2 suite: there is no v1 migration, suite negotiation, compatibility
mode, suite floor, or suite-transition object. No vector may be regenerated with a different suite,
field registry, schema, or encoding profile. Any change requires a new protocol decision and
independent review.

Negative cases must continue to map to `invalid_crypto_object` except for a suite value other than
`2`, which maps to `unsupported_crypto_suite`. This coarse mapping is part of the public contract.
