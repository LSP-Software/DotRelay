# Device proof of possession for Device-scoped routes

Status: accepted

The API identified the acting Device by the `X-DotRelay-Device-Id` header and checked that the
named Device was `ACTIVE` and belonged to the session's User. Nothing in the request showed that
the client held that Device's key. ADR 0013 and the authentication wiki require a validated active
Device for password and passkey wrappers, and say a session never grants Device authority; Device
authority must therefore rest on the Device key, for every Device-scoped route, not only for the
operations that already carry a Device signature.

## Decision

Every Device-scoped request carries a **Device proof**: a short-lived token that the Device
obtains by signing a challenge from the service with its Ed25519 key. A proof is bound to one
session and one Device. A session without a proof acts as no Device at all.

### Obtaining a proof

1. `POST /api/v1/devices/proofs/challenges` needs a signed-in session and no Device. It returns
   `{ challenge, expiresIn }`. The challenge is 57 bytes, sent as unpadded base64url: version
   byte `1`, a random 16-byte nonce, the issue time as a big-endian 64-bit millisecond count,
   and a 32-byte HMAC-SHA-256 tag over the nonce, the issue time and the session id. It is valid
   for 120 seconds.
2. The client signs this message with the Device's Ed25519 key:

   ```text
   "dotrelay-device-proof-v1" || 0x00 || Server Profile id (16 bytes)
     || User id (16 bytes) || Device id (16 bytes) || challenge (57 bytes)
   ```

   The prefix differs from every other message a Device key signs: protocol objects start with
   `DotRelay\0`, the transfer acknowledgement has its own prefix, and the revoke and recovery
   commands are JSON.

3. `POST /api/v1/devices/proofs` with `{ deviceId, challenge, signature }` returns
   `{ token, deviceId, expiresIn }`. The service checks the challenge tag against the current
   session, the challenge age, that the Device is `ACTIVE` and belongs to the session's User, and
   the signature against the Device's stored Ed25519 key.

The token is 73 bytes, sent as unpadded base64url: version byte `1`, the Device id, the expiry
as a big-endian 64-bit millisecond count, the challenge nonce, and a 32-byte HMAC-SHA-256 tag over
those fields, the User id and the session id. It expires 300 seconds after its challenge was
issued. Because every field comes from the challenge, replaying an exchange returns the same
token and never extends its life.

Both tags use a key derived from `BETTER_AUTH_SECRET` with HKDF-SHA-256 (salt: the Server Profile
id, info: `dotrelay-device-proof-v1`), with a separate label for challenges and tokens. Every API
replica derives the same key, so the service stores nothing per proof.

### Presenting a proof

A Device-scoped request sends the token in `X-DotRelay-Device-Proof`. Clients keep sending
`X-DotRelay-Device-Id` as the claimed Device; when both headers are present they must name the
same Device (`400 invalid_request` otherwise). The service accepts the request as that Device only when the token's tag verifies
for the request's session and User, the token has not expired, and the Device is still `ACTIVE`.
A missing, malformed, expired or foreign proof is `401 device_proof_required`. A revoked Device
is `403 device_not_active`, as before. Signing out, session expiry and Device revocation end every
proof tied to that session or Device on the next request, because the session and Device checks
run on every request.

Clients cache the token, refresh it before `expiresIn` runs out (measured on their own clock, so
clock skew does not matter), and after a `401` on a Device-scoped request obtain a new proof and
send the same request once more. The service rejects a request without a valid proof before any
route logic runs, so the retry cannot apply a mutation twice. Retries keep their operation id,
`Idempotency-Key` and body, so idempotency is unchanged.

### What a session alone still sees

- `GET /api/v1/workspace/boundary` without a proof returns the session view: the session, the
  catalog, the selected Environment's ids and head, the Server Profile, and `activeDeviceCount`.
  The Device-scoped fields are empty or absent: no Device, and empty `peerDevices`,
  `signingTrustDevices`, `signingTrustKeys`, `accountRosters` and `epochKeyLinks`, with no epoch
  grant and no Account Key Envelopes. A request with an invalid proof gets
  `401 device_proof_required` rather than the session view, so a client never mistakes an
  expired proof for a missing Device. A valid proof for a Device revoked since it was issued
  reads as no Device, as a revoked Device always has.
- `GET /api/v1/account-keys/wrappers` without a proof still returns only the Recovery Code
  wrapper and its creator key (ADR 0013).
- Session-only routes stay session-only: bootstrap, enrollment begin, the invitation inbox and
  responses, and the Team membership listing. The membership listing keeps each Member's Account
  Device roster. Rosters are public key material signed by each account identity, and teammates'
  clients need them to pin identities (ADR 0015). Once Device ids stop working as credentials,
  the ids inside a roster grant nothing.

## Alternatives considered

**Sign every request.** Each request would carry a Device signature over its method, path,
query, body digest, a timestamp, a nonce and the session id, and the service would store each
nonce for the timestamp window. This avoids a reusable token, but it has three costs. The CLI
retries a transient failure by resending the same bytes so a mutation keeps its operation id; a
single-use nonce would turn a lost response into a replay rejection unless every retry signed
again. The web app reaches the API through its own server for the workspace boundary, so the
browser would have to reproduce the exact request target that a second hop sends, behind any
proxy. And strict replay protection needs a database write for every Device-scoped request. What
this ADR has to guarantee is that a session alone never acts as a Device, and a proof the session
cannot produce without the Device key guarantees that either way.

**A stateful token table.** Storing issued tokens would allow explicit revocation, but session
deletion and Device revocation already end a stateless token, and a table adds a write per proof
and a retention job.

## Consequences

- A session alone, however it was obtained, acts as no Device: it reaches no password or passkey
  wrapper, no envelopes or ciphertext, and no Device-scoped mutation.
- Whoever holds both a session and a live proof can act as that Device until the proof expires.
  Anyone with that much access to a client (same-origin script, or the CLI process or its state
  directory) can usually use the Device key itself, which the threat model already excludes.
- The CLI and the browser make two extra requests the first time a process or page needs a
  Device, and again every five minutes while it stays active.
- `X-DotRelay-Device-Id` alone no longer authorizes anything. The API, CLI and web ship together.
