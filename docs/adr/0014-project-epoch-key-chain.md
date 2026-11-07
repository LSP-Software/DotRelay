# Project epoch keys form a signed backward key chain

Status: accepted

`dotrelay project rotate` advances a Project to a new epoch and seals Shared Values published
afterwards under a fresh Project Epoch Key. It does not re-encrypt existing lanes, so Values
published before a rotation stay sealed under the older key. A Device that only ever received the
current key (a Member who joined after a rotation, or a Device holding only a
`CURRENT_PROJECT_EPOCH` grant) could not read those Values and every pull failed with
`UnreadableLaneError`. The stopgap read the User's own past-epoch Account Key Envelopes, which only
helps Users who already held the older keys.

## Decision

Every rotation from epoch `n` to `n + 1` publishes one **Project Epoch Key Link**: the epoch-`n`
key sealed under the epoch-`n + 1` key, signed by the rotating Device. Anyone holding the current
key walks the links backwards and rebuilds the whole key ring. There is no per-Member or per-Device
fan-out.

### Protocol object

The link is protocol object kind 23, registered in `@dotrelay/contracts`:

| Field | Meaning                                            |
| ----- | -------------------------------------------------- |
| 8     | Server Profile id                                  |
| 11    | Team id                                            |
| 13    | Project id                                         |
| 17    | Correlation ID (random)                            |
| 23    | signing Device id                                  |
| 32    | created-at Unix milliseconds                       |
| 44    | HKDF salt (32 random bytes)                        |
| 46    | AES-GCM IV                                         |
| 47    | ciphertext of the epoch-`n` key (48 bytes)         |
| 48    | SHA-384 of the ciphertext                          |
| 62    | previous Project epoch `n` (from)                  |
| 63    | new Project epoch `n + 1` (to)                     |
| 71/72 | declared plaintext length 32, ciphertext length 48 |
| 3/4   | unsigned body and Ed25519 signature                |

Protocol validation requires `63 = 62 + 1`, `62 >= 1`, plaintext length 32, and ciphertext length 48. The encryption key is HKDF-SHA-384 over the epoch-`n + 1` key with the field-44 salt and the
info string `DotRelay\0dotrelay-e2ee-v3-classical-webcrypto\0Project-epoch-key-link\0v1`,
used for AES-256-GCM. The associated data is the canonical CBOR of every field except 3, 4, 47, 48
and 72, so it binds the Server Profile, Team, Project, from-epoch, to-epoch, signer, salt and IV.

### Rotation

The rotating client generates the new epoch key **before** it begins the operation, seals the
current key into a link, and stages the link with the per-Environment transitions. The
`epoch-transitions` request names it in a required `keyLink.protocolObjectId` field, so a request
carries exactly one link. A client that does not hold the current epoch key cannot build a link and
the rotation stops before anything is sent: rotation fails closed.

The API checks the link before `ProjectEpochRepository.rotate` commits: kind 23, Server Profile,
Team and Project match, `62` equals the expected epoch and `63` the new epoch, field 23 names the
acting Device, and the signature verifies with that Device's stored key. `rotate` stores the link in
`project_epoch_key_links` in the same transaction as the epoch advance, with one row per
`(projectId, toEpoch)`. A byte-identical retry of the operation is idempotent; a retry under the
same operation id with a different link is a conflict.

### Serving and verification

`GET /api/v1/workspace/boundary` returns `epochKeyLinks`, the Project's links as base64 canonical
bytes ordered by to-epoch. Clients verify before use, walking from the current epoch down:

- exactly one link per to-epoch (a duplicate stops the walk),
- the link parses, is kind 23, and binds the expected Server Profile, Team and Project,
- `63` is the epoch being walked and `62 = 63 - 1` (contiguous, no gaps),
- the signature verifies against the Team's Device signing keys, and
- AES-GCM opens with the to-epoch key and the recomputed associated data.

The first failure or gap stops the walk; older epochs stay unreadable and the sync names those
lanes, exactly as before. The verified keys feed the existing `sharedValueKeyRing`.

The service never holds an epoch key, so it cannot forge a link that opens: authenticity of the
sealed key comes from AES-GCM under the to-epoch key. The signature attributes the link to a Device.
Until the account Device roster lands (ADR 0015), the signing keys come from the server-reported
Team trust set, so the signature alone is not proof against a hostile server.

### Backfill

Projects rotated before this change have no links. During a pull, a client that finds a gap and
holds the User's Account Master Key opens its past-epoch Account Key Envelopes, creates every
missing link it can (both ends known), and publishes each through
`POST /api/v1/projects/:projectId/epoch-key-links`. The endpoint requires an active Device of an
active Member, a to-epoch no greater than the current epoch, and the same binding and signature
checks as rotation. The first link for a to-epoch wins; a byte-identical retry is idempotent and a
different link for the same to-epoch is a `state_conflict`. The client then rebuilds the ring from
the chain. Past-epoch Account Key Envelopes remain only as the backfill source; the read path uses
the chain.

A Member could publish a backfill link that seals the wrong key. It cannot reveal anything: the
walk then fails to open older lanes, which is the same outcome as no link. Removing that Member
and rotating does not repair the bad link; an Owner who still holds the older keys must publish a
corrected link after the bad one is removed by an operator.

### Historical grants

The `HISTORICAL_PROJECT_EPOCH` grant kind stays reserved and unused. The chain replaces the need for
it; removing it would change the closed v3 registry for no benefit.

## Consequences

- Rotation stops a removed Member from reading Values published after the rotation. It never
  revokes Values they already saw, and the chain gives every current Member every older epoch
  key. To cut off a removed Member from a secret, rotate the secret itself.
- New Members and new Devices need only the current epoch key.
- The registry, protocol validation, OpenAPI and v3 vectors change together; ship API, web and CLI
  together, as for every pre-alpha v3 registry extension.
- A new migration adds `project_epoch_key_links`; no existing rows change.
