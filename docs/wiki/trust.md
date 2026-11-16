# Device trust, grants, recovery, and rotation

DotRelay separates **authentication** (Better Auth session), **Device authorization** (client
installation keys), and **Membership access** (Team role plus key grants). This page documents the
v3 classical trust workflows implemented in `packages/database` and exercised by the trust
integration suite.

## Device versus session

A browser or CLI session identifies the server-local User. It does not authorize decryption,
Manifest publication, or grant creation. Protected operations require an **active Device** bound to
that User, and the client must prove it holds that Device's signing key with a Device proof
([ADR 0020](../adr/0020-device-proof-of-possession.md)); naming a Device id in a header proves
nothing. Device lifecycle states are `PENDING` (enrollment in progress), `ACTIVE`, and `REVOKED`.

`REVOKED` is terminal ([ADR 0021](../adr/0021-device-revocation-is-terminal.md)). Enrollment
reuses an existing Device row only while it is `PENDING` and only with the same keys, and a
database trigger refuses any write that moves a Device out of `REVOKED`, back to `PENDING`, or
changes its activation time, revocation time, owner or keys. Clients judge every Revision a
Device signed by those times, so they never change.

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

The same User's CLI and browser Devices share the current Project epoch key through grant bootstrap
(`POST /api/v1/grants/bootstrap`). The first Device creates the key. Later Devices receive a wrap of
that key, then Shared Values can be sealed to it instead of to a single Device.

Who may create a grant depends on its recipients. Any active Member with an active Device may seal
the Project key to another of their own active Devices: they already hold the key, so the grant
discloses nothing new. Clients pick those Devices from the User's verified roster (ADR 0015). A grant
to another User's Device, and every Membership-scoped grant, needs owner or admin authority, as for
Project administration. Grant bootstrap only ever targets the actor's own Devices and answers
`forbidden` for anyone else's; other Users receive keys through Membership provisioning. Pending and
removed Members cannot create grants.

A grant carries key material on its signer's word alone, so a client accepts one only when an
active Device of its own verified roster, or of a teammate the user confirmed, signed it
([ADR 0022](../adr/0022-client-trust-anchors-and-key-adoption.md)). A client that holds the AMK
prefers its own Account Key Envelope to any grant.

**`MembershipRepository.activate`** commits a membership activation object only after the required
grant count is present.

## Recovery

Users may store an encrypted **Account Master Key wrapper** of type `RECOVERY_CODE` on the
server. Creating a wrapper publishes a one-time Recovery Code (a 13x4 code) that unlocks the
Account Master Key; presenting the code exchanges it for an AMK recovery, and a new code
invalidates the previous one. The server stores the encrypted wrapper and never the Recovery
Code or the AMK plaintext.

Recovery Code generation, presentation, and key exchange are client, browser, and CLI responsibilities
(ADR 0009). The server enforces one active recovery-code wrapper per User and refuses codes
that do not match the stored wrapper.

An optional `PASSWORD` wrapper, set and used in the browser, derives its key with Argon2id
(64 MiB of memory, 3 passes, 1 lane by default; the parameters are stored in each wrapper and
capped before any memory is allocated) and then HKDF-SHA-384. Anyone holding the server's database
can guess it offline, so `encryptionPasswordProblem` in `@dotrelay/client` refuses a password
shorter than 12 characters, a repeated, sequential or all-number pattern, or one built on a common
word with digits, symbols or letter substitutions around it. A password set under the older
8-character rule still unlocks; the browser then asks the person to change it, and **Change** adds
the new password wrapper before it retires the old one.

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

Each installation pins, per Project, the highest epoch it accepted and a local commitment to the
Project Epoch Key of each epoch it holds. A client refuses an epoch older than that mark, a
different key for a pinned epoch, and a Revision whose epoch is lower than its parent's, and it
never publishes under an older epoch than the verified head's
([ADR 0022](../adr/0022-client-trust-anchors-and-key-adoption.md)).

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
  missing or its keys changed, and records Devices the service reports revoked. A first roster
  lists only the publishing Device. Another Device joins only when the user approved it on the
  publishing Device: an enrollment it approved, or an Account Key Transfer target whose key
  fingerprint the user confirmed. The service's report never adds a Device. A revoked entry stays
  revoked.
- **Own pins.** The client pins its own identity and roster version: the CLI in a protected file
  in its state directory, the browser in the wrapped IndexedDB Device record store. It rejects a
  roster that its AMK-derived key did not sign and any lower version. A client that lost its pins
  trusts nothing for its own account until it restores the AMK.
- **Teammates.** A teammate's identity is pinned on first sight, for verifying their history only.
  Their Devices count only when a roster signed by the pinned identity lists them. No grant from
  them is accepted until the user compares fingerprints and confirms the identity
  (`dotrelay team trust <user-id>`, **Confirm fingerprint** in Members, or the share-keys
  question). Without a terminal, `dotrelay team trust` and `dotrelay team share-keys` confirm
  only with `--fingerprint <fingerprint>`, which must match the teammate's identity. A first-sight
  author can change a Value only with a lane sealed for their own Revision, and their legacy
  (format 1) lanes are not applied until the user confirms them
  ([ADR 0023](../adr/0023-lanes-are-bound-to-their-revision.md)). A changed identity, a lower version, or a missing roster, whether the service sends
  null or leaves the User out, blocks that teammate: no grants or provisioning go to them and their
  Revisions do not verify, until the user compares fingerprints and re-trusts them
  (`dotrelay team trust <user-id>` or **Trust new key** in Members). A confirmed or re-trusted pin
  keeps the roster version the user saw.

Roster-verified keys replace the service's lists for Revision signing trust (a revoked roster
entry also ends the Device's window), grant signature trust, the own peers that receive the
Project Epoch Key and the Account Master Key, Membership provisioning recipients, and Project Epoch
Key Link signatures. Account Key Envelopes and Wrappers are sealed under the AMK or a User-held
secret; that seal authenticates them, and their signatures may come from any Device the service
reports for the account.

### Users without a roster

Nothing is trusted from absent data
([ADR 0022](../adr/0022-client-trust-anchors-and-key-adoption.md)). A User without a roster this
client can verify is **unverified**, and none of their Devices count. A client that holds the AMK
and finds no roster for its own account publishes one that lists only itself; a client without the
AMK or a pin trusts only its own Device. A Device that never held the AMK, or was revoked before
the account's first roster, is not listed, so its history does not verify until a Device with the
AMK approves it again or sends it the key with a confirmed fingerprint.

### Handing a new Device the account key

- **Enrollment approval.** `dotrelay device approve` adds the enrolled Device to the roster with
  the keys from the request file the user carried over, when the approving Device holds the AMK.
- **Sending a transfer.** The sender seals the AMK only to a Device its verified roster lists,
  using the rostered key. For a Device not listed yet, the user compares the key fingerprint the
  service reports with the one that Device shows (`dotrelay device list`, or Recovery in the
  browser), and the sender adds it to the roster before sealing. The browser does not show the
  service's value: the person types the fingerprint the receiving Device shows, and the sender
  seals only when it matches the keys the service reports.
- **The transfer code.** The sender shows `<transfer id>.<account fingerprint>`. The person carries
  that code to the receiving Device.
- **Receiving a transfer.** The receiver accepts the key only when a roster signed by the identity
  that key derives lists both the sender and the receiver, the identity matches any own pin, and
  the fingerprint matches the code. A key the service substituted fails all three.

### What the roster does not cover

A Recovery Code restore trusts the roster the service serves at that moment. Membership windows
also come from the service. Membership
windows still come from the service. Each `signingTrustDevices` entry carries `membershipPeriods`,
every period in which the author was an active Member; a Member who was removed and invited back
keeps one period per stint, so their earlier Revisions stay verifiable
([ADR 0017](../adr/0017-membership-periods-survive-reinvitation.md)).

## Security boundaries

Trust repositories never persist private keys, Recovery Codes, AMK wrappers in plaintext, bearer
tokens, or decrypted Manifest content. Protocol objects store canonical bytes and SHA-384 digests only. Staged
objects expire after the configured operation lifetime and become visible only through explicit
finalization.

## Related docs

- [Authentication and Server Profile trust](./authentication.md)
- [Administration policy](./administration.md)
- [PostgreSQL persistence](./persistence.md)
