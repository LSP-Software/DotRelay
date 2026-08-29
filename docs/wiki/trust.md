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

The first Device for a User uses **`DeviceRepository.completeBootstrap`**. Bootstrap is allowed only
while the User has zero active Devices. It commits a Device certificate protocol object and creates
the Device as `ACTIVE` without a dual-control enrollment record.

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

**`MembershipRepository.activate`** commits a membership activation object only after the required
grant count is present. Owner and admin authority for grant creation follows the same Team action
rules as Project administration.

## Recovery

Users may store an encrypted **Recovery envelope** on the server via
**`RecoveryRepository.replaceEnvelope`**, advancing `recoveryGeneration` by one and retiring prior
envelopes. Recovery attempts are append-only audit rows keyed by challenge hash; they never store
Recovery Kit bytes or plaintext.

Recovery Kit generation, export, local proof, and identity rollover remain client responsibilities.
The server enforces generation counters and refuses stale envelopes.

## Epoch rotation

**`ProjectEpochRepository.rotate`** atomically advances a Project epoch, publishes
`EPOCH_TRANSITION` revisions for every active Environment, and records epoch transition objects.
Stale expected epochs surface as reconciliation failures rather than silent rewrites.

## Security boundaries

Trust repositories never persist private keys, Recovery Kit material, bearer tokens, plaintext, or
decrypted Manifest content. Protocol objects store canonical bytes and SHA-384 digests only. Staged
objects expire after the configured operation lifetime and become visible only through explicit
finalization.

## Related docs

- [Authentication and Server Profile trust](./authentication.md)
- [Administration policy](./administration.md)
- [PostgreSQL persistence](./persistence.md)
