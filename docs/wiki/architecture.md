# Architecture and wire boundaries

Code stays in its owning application until a second real consumer exists. Shared packages are
private, use `workspace:*`, and expose only intentional public exports. Database, cache,
authentication, and web UI code remain application-local until actual reuse appears.

The hosted and self-hosted products use the same backend build and protocol. The runtime-neutral
`@dotrelay/contracts` package is the only shared contract boundary: apps consume its public exports,
while it contains no Bun, browser, Node, persistence, authentication, or service code.

Administrative HTTP uses strict JSON under `/api/v1` and stable `application/problem+json` codes.
Capabilities, pagination, idempotency, and the checked OpenAPI output are part of that package.
Protected grants, trust objects, lane objects, Manifest descriptors, Revisions, and epoch lifecycle
objects use
`application/vnd.dotrelay.e2ee-v2+cbor`; their exact canonical bytes remain bytes at the API boundary.
They are never JSON-reserialized, base64-wrapped, compressed, fetched through a generic object
endpoint, or negotiated with another suite.

This is a v2-only protocol: it has no v1 migration, suite negotiation, compatibility mode, suite
floor, or suite-transition object. The epoch lifecycle object is for Project key rotation within
v2 and is not a migration or compatibility mechanism.

The closed suite value is unsigned CBOR `2`. The deterministic codec rejects noncanonical encodings,
unknown or duplicate fields, invalid UTF-8, tags, indefinite lengths, floats, forbidden v1 values,
invalid fixed lengths, and values above the frozen depth/size ceilings. Human-readable Environment
and Variable content is not a protocol value and is never present in the vectors.

The immutable corpus is under `test-vectors/e2ee/v2/`; its SHA-384 manifest commits all artifacts,
and its RFC known-answer cases pin primitive inputs, outputs, and HKDF intermediates. Bun and
Chromium execute the same browser/Bun bytes. Its tests cover all object kinds, conditional shapes,
enum registries, malformed input, coarse errors, and limits. Cryptographic provider integration,
ACVP execution, independent oracle results, and independent security approval remain gates for
secret-capable work.

## Contract reference

The wire registry is closed: fields `0`–`85`, object kinds `1`–`19`, and schema version `1` are
defined in `packages/contracts/src/registry.ts`. The suite and API constants are `2` and `v1`.
Fixed lengths include ML-KEM public/ciphertext `1184/1088`, ML-DSA public/signature `1952/3309`,
Ed25519 public/signature `32/64`, SHA-384 commitments `48`, XChaCha nonces `24`, opaque IDs `16`,
and four-key public identities `3200` bytes. Enum registries cover mutation `1–5`, lane scope
`1–4`, key kind `1–3`, grant kind `1–7`, membership role `1–3`, and lifecycle `1–6`.

Hard ceilings are: canonical object/descriptor `64 MiB`, administrative JSON `256 KiB`, CBOR
depth `12`, staging `256` objects/`16 MiB` with a `24-hour` default TTL, synchronization `256`
objects/`16 MiB`, grant plaintext `4 KiB`, Recovery plaintext `16 KiB`, `10,000` Manifest
variables, and `100,000` current lane commitments. Variable names are `256` ASCII bytes,
descriptions `16 KiB` validated UTF-8, and Values `1 MiB` validated UTF-8.

The public problem registry is in `packages/contracts/src/errors.ts`. It preserves the stable
status mapping: malformed requests and crypto objects `400`; authentication `401`; authorization
`403`; missing resources `404`; state conflicts `409`; expired invitations/staging `410`; size
`413`; media type `415`; unsupported API/suite/runtime `422`; rate limiting `429`; and
service/provider/rate-limit availability `503`. Protocol failures intentionally collapse to
`invalid_crypto_object`, except a non-`2` suite, which is `unsupported_crypto_suite`. Runtime and
provider errors are stable pre-secret-processing contracts; provider implementation belongs to #26.
