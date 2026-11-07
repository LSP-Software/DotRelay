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

## Display metadata

Each Device row may carry cleartext display metadata: `displayName` (auto hostname or browser
summary until the owner renames it), `nameOverridden`, `clientKind` (`CLI` / `BROWSER`), `osName`,
and `clientSummary`. Labels live outside the signed Device certificate (ADR 0012). The owning
installation refreshes an un-overridden name on each session via `POST /api/v1/devices/self`; a
rename freezes the label until `resetName`. Boundary responses expose optional `name`, `clientKind`,
`osName`, and `clientSummary` on `device` and each `peerDevices` entry for the Devices table and
recovery target picker.

## Initial trust bootstrap

A User's **first** Device uses **`DeviceRepository.completeBootstrap`**. The User must have
an authenticated session and no other `ACTIVE` Device: bootstrap is first-Device-only
(ADR 0010), and a second bootstrap for a User that already has an `ACTIVE` Device is rejected —
"already been bootstrapped; use enrollment". It commits a Device certificate protocol object and
creates the Device as `ACTIVE` without an enrollment record. A
session-bootstrapped Device is a fully active Device (ADR 0010): it satisfies the same
`ACTIVE` lifecycle gate as an enrolled Device and may act on the User's behalf, including
approving an enrollment that a prospective Device self-started. A byte-identical retry of a
committed bootstrap returns idempotently instead of being rejected. A Device whose only Device
was revoked may bootstrap again, since revoked Devices are not counted.

Dual-control enrollment is the only path for additional Devices — for example the browser
joining after the CLI is already active. The new installation or browser generates its keys and
self-starts the enrollment; one of the User's existing Devices approves it. It is not a gate a
bootstrap Device must pass.

## Dual-control enrollment

Additional Devices use a three-step server workflow:

1. **`beginEnrollment`** — the prospective Device self-starts its own enrollment with an
   authenticated session, recorded as a `PENDING` Device together with transcript and
   challenge hashes and an expiry time. The User must have at least one `ACTIVE` Device that
   can approve it; a User with none must bootstrap instead.
2. **`approveEnrollment`** — an existing `ACTIVE` Device records an enrollment approval
   object, which activates the prospective Device and records its self-signed certificate.
   The approver is always a different Device from the prospective initiator; when the User
   has a single Device, that sole Device approves.
3. **`completeEnrollment`** — after approval, the now-`ACTIVE` prospective Device confirms
   the staged enrollment object, closing the enrollment record.

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

### Project key chain

Rotation does not re-encrypt existing lanes, so Values published before a rotation stay sealed
under the older epoch key. Every rotation therefore also publishes one **Project Epoch Key Link**
(protocol object kind 23, ADR 0014): the previous epoch key sealed under the new one with
AES-256-GCM, with associated data that binds the Server Profile, Team, Project, from-epoch and
to-epoch, and signed by the rotating Device.

- The rotating client generates the new key first and stages the link with the transitions. A
  client that does not hold the current key cannot rotate. Until the commit is confirmed, the CLI
  keeps the new key sealed to its own Device in its state directory, and discards it only when
  cancelling the operation succeeds (a cancelled operation can never commit). If the outcome is
  unknown, the next `dotrelay pull` adopts the key once the served link for the new epoch opens
  with it.
- The API rejects a rotation that does not carry exactly one valid link for `expectedEpoch ->
newEpoch`, signed by the acting Device. The link is stored in `project_epoch_key_links` in the
  same transaction as the epoch advance. A byte-identical retry is idempotent.
- The workspace boundary serves the Project's links as `epochKeyLinks`. Clients walk them from
  the current key down to epoch 1, checking binding, contiguity, single link per epoch, the
  signature against the Team's Device signing keys, and the AES-GCM tag. The first failure stops
  the walk, and the older epochs stay unreadable.
- A Member who joins after any number of rotations, or a Device that only holds a
  `CURRENT_PROJECT_EPOCH` grant, needs only the current key to read every Value.

Projects rotated before links existed are backfilled. A client that finds a missing link and
holds the Account Master Key opens the User's past-epoch Account Key Envelopes, creates every
link it holds both keys for, and publishes it through
`POST /api/v1/projects/:projectId/epoch-key-links`. Any active Member's active Device may
backfill. The first link for a to-epoch wins; a different link for it is a `state_conflict`.

The service cannot forge a link that opens, because it never holds an epoch key. The signing keys
used to check a link are the roster-verified keys described below.

**What rotation does and does not do.** Rotation stops a removed Member from reading Values
published after it. It never revokes Values they already saw, and every current Member can still
read every older Value through the chain. To cut a removed Member off from a secret, rotate the
secret itself and publish the new Value.

## Account identity and Device rosters

The service is untrusted for integrity as well as confidentiality, so clients no longer take Device
keys from its JSON (ADR 0015).

- **Account signing key.** Every client that holds a User's Account Master Key derives the same
  Ed25519 key from it (HKDF-SHA-384, info `dotrelay-account-signing-ed25519-v1`, salt = Server
  Profile id and User id). Its public key is the User's account identity.
- **Account Device roster.** Protocol object kind 24, signed by the account signing key, lists the
  User's Devices with their X25519 and Ed25519 keys, active or revoked with a revocation time.
  `POST /api/v1/account-keys/rosters` stores version 1, then only `latest + 1` under the same
  identity. The workspace boundary serves `accountRosters` for the User and every User in the
  Team's signing trust set; Membership listings and provisioning plans carry each Member's roster.
- **Publishing.** A client that holds the AMK publishes a new version when its own Device is
  missing or its keys changed, and records Devices the service reports revoked. It never adds
  another Device. A revoked entry stays revoked.
- **Own pins.** The client pins its own identity and roster version: the CLI in a protected file
  in its state directory, the browser in the wrapped IndexedDB Device record store. It rejects a
  roster that its AMK-derived key did not sign and any lower version. A client that lost its pins
  trusts nothing for its own account until it restores the AMK.
- **Teammates.** A teammate's identity is pinned on first sight. Their Devices count only when a
  roster signed by the pinned identity lists them. A changed identity, a lower version, or a
  vanished roster blocks that teammate: no grants or provisioning go to them and their Revisions
  do not verify, until the user compares fingerprints and re-trusts them
  (`dotrelay team trust <user-id>` or **Trust new key** in Members).

Roster-verified keys replace the service's lists for Revision signing trust (a revoked roster
entry also ends the Device's window), grant and Account Key signature trust, the own peers that
receive the Project Epoch Key, Membership provisioning recipients, and Project Epoch Key Link
signatures.

### Upgrade window

The first client with a User's AMK after the upgrade publishes that User's version-1 roster from
the Devices the service reports, active and revoked. Until then the User is **unverified**:
clients keep the old behaviour for their Devices and show them as unverified in
`dotrelay team members` and the Members view. The window closes per User as soon as any of their
clients with the AMK runs.

### What the roster does not cover

Adding a new Device is still a user decision on what the service shows: the AMK handoff during
enrollment approval, Account Key Transfer, or Recovery Code restore happens before the new Device
can be listed. Once it lists itself, no other Device can join without an AMK holder. Membership
windows still come from the service.

## Security boundaries

Trust repositories never persist private keys, Recovery Codes, AMK wrappers in plaintext, bearer
tokens, or decrypted Manifest content. Protocol objects store canonical bytes and SHA-384 digests only. Staged
objects expire after the configured operation lifetime and become visible only through explicit
finalization.

## Related docs

- [Authentication and Server Profile trust](./authentication.md)
- [Administration policy](./administration.md)
- [PostgreSQL persistence](./persistence.md)
