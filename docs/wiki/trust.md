# Device trust, grants, recovery, and rotation

DotRelay separates **authentication** (Better Auth session), **Device authorization** (client
installation keys), and **Membership access** (Team role plus key grants). This page documents the
v3 classical trust workflows implemented in `packages/database` and exercised by the trust
integration suite.

## Device versus session

A browser or CLI session identifies the server-local User. It does not authorize decryption,
Manifest publication, or grant creation. Protected operations require an **active Device** bound to
that User. Device lifecycle states are `PENDING` (enrollment in progress), `ACTIVE`, and `REVOKED`.

Revocation and Membership removal are logical lifecycle changes. DotRelay never claims to erase keys
or plaintext that were already downloaded to a client.

## Initial trust bootstrap

A Device for a client installation uses **`DeviceRepository.completeBootstrap`**. The User must have
an authenticated session. CLI and browser are distinct Devices, so bootstrap may run again for this
browser after the CLI is already enrolled. It commits a Device certificate protocol object and
creates the Device as `ACTIVE` without a dual-control enrollment record. A
session-bootstrapped Device is a fully active Device (ADR 0010): it satisfies the same
`ACTIVE` lifecycle gate as an enrolled Device and may act on the User's behalf, including
approving an enrollment that a different Device initiated.

Dual-control enrollment remains the CLI handoff for adding a Device whose keys are generated on
an already enrolled installation; it is not a gate a bootstrap Device must pass.

## Dual-control enrollment

Additional Devices use a three-step server workflow:

1. **`beginEnrollment`** — an existing active Device initiates enrollment, recording transcript and
   challenge hashes with an expiry time.
2. **`approveEnrollment`** — a different active Device records an enrollment approval object. The
   initiator and approver must not be the same Device.
3. **`completeEnrollment`** — after approval, the initiator finalizes staged enrollment and
   certificate objects, creating the new Device as `ACTIVE`.

Expired, replayed, or unapproved enrollments fail closed. Operations are idempotent on byte-identical
retries and conflict when an operation id or digest is reused with different bytes.

## Membership key grants

Invitations create Memberships in `PENDING_KEY_GRANT`. **`GrantRepository.create`** stores encrypted
grant protocol objects with exact recipient-set validation: every listed recipient Device must be
active, and Membership-scoped grants require a pending Membership on the same Team.

The same User's CLI and browser Devices share the current Project epoch key through grant bootstrap.
The first Device creates the key. Later Devices receive a wrap of that key, then Shared Values can
be sealed to it instead of to a single Device.

**`MembershipRepository.activate`** commits a membership activation object only after the required

**`MembershipRepository.activate`** commits a membership activation object only after the required
grant count is present. Owner and admin authority for grant creation follows the same Team action
rules as Project administration.

## Recovery

Users may store an encrypted **Account Master Key wrapper** of type `RECOVERY_CODE` on the
server. Creating a wrapper publishes a one-time Recovery Code (a 13x4 code) that unlocks the
Account Master Key; presenting the code exchanges it for an AMK recovery, and a new code
invalidates the previous one. The server stores the encrypted wrapper and never the Recovery
Code or the AMK plaintext.

Recovery Code generation, presentation, and key exchange are client, browser, and CLI responsibilities
(ADR 0009). The server enforces one active recovery-code wrapper per User and refuses codes
that do not match the stored wrapper.

## Epoch rotation

**`ProjectEpochRepository.rotate`** atomically advances a Project epoch, publishes
`EPOCH_TRANSITION` revisions for every active Environment, and records epoch transition objects.
Stale expected epochs surface as reconciliation failures rather than silent rewrites.

## Security boundaries

Trust repositories never persist private keys, Recovery Codes, AMK wrappers in plaintext, bearer
tokens, or decrypted Manifest content. Protocol objects store canonical bytes and SHA-384 digests only. Staged
objects expire after the configured operation lifetime and become visible only through explicit
finalization.

## Related docs

- [Authentication and Server Profile trust](./authentication.md)
- [Administration policy](./administration.md)
- [PostgreSQL persistence](./persistence.md)
