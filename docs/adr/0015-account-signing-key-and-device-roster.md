# Account signing key, signed Device roster, and pinned teammates

Status: accepted

Clients used to take Device signing and encryption keys from the service's boundary JSON
(`signingTrustDevices`, `peerDevices`, provisioning plans) and trust them. A service that is
untrusted for integrity could add a Device it controls to a User, swap a teammate's keys, or bring
a revoked Device back, and clients would sign grants to it and accept its Revisions. This ADR moves
Device trust onto a key the service never holds.

## Account signing key

Each User derives an Ed25519 **account signing key** from the Account Master Key:

```text
seed = HKDF-SHA-384(ikm = AMK,
                    salt = Server Profile id (16 bytes) || User id (16 bytes),
                    info = "dotrelay-account-signing-ed25519-v1", 32 bytes)
```

The AMK never changes (ADR 0009), so the key is stable per User per Server Profile. Its public key
is the User's **account identity**. A dedicated info string keeps it independent from every other
AMK use; a future derivation would use a new versioned string and an explicit migration.

## Account Device roster

The roster is protocol object kind 24, signed by the account signing key and stored by the
service:

| Field | Meaning                                      |
| ----- | -------------------------------------------- |
| 8, 9  | Server Profile id, User id                   |
| 32    | created-at Unix milliseconds                 |
| 41    | account identity (Ed25519 public key)        |
| 98    | roster version, starting at 1, +1 per change |
| 99    | entries: one map per Device                  |

Each entry carries field 10 (Device id), 39 (X25519 key), 41 (Ed25519 key), 32 (added-at),
79 (lifecycle `2` active or `3` revoked) and, only for revoked entries, 100 (revoked-at). Device
ids are unique and a roster lists at most 256 Devices. Revoked entries stay in later versions, so a
revoked Device can never be resurrected by omission.

The service accepts version 1 from any active Device of the User, then only `latest + 1`, signed by
the same account identity as version 1. It serves the latest roster for the User and every User in
the Team's signing trust set. These are consistency checks for an honest service; clients do not
rely on them.

### Publishing

Any client that holds the AMK can publish. It publishes when its own Device is missing from the
latest verified roster, or its listed keys differ. That one rule covers bootstrap, enrollment
(the new Device publishes after it receives the AMK), and every restore flow. Revoking a Device
publishes a new version that marks it revoked.

A Device that never receives the AMK cannot publish; teammates do not trust it until a Device with
the AMK lists it. That matches ADR 0010: a Device without the AMK decrypts nothing.

### Own Devices

Each client pins its own account identity and the highest roster version it has verified (CLI
state directory, protected file; browser: the wrapped IndexedDB Device record store). It rejects:

- a roster not signed by the identity it derives from its own AMK,
- a roster version lower than the pinned one (rollback),
- any own Device, peer, or signer key not in the verified roster.

A client that loses local state has no pin. It must restore the AMK (Recovery Code, password,
passkey, or approval from another Device) and derive the identity again before it trusts any
roster. The service cannot forge a roster for it, because the client checks it against the
derived identity, not one the service supplies.

## Teammates

On first sight a client pins each teammate's account identity (trust on first use) together with
the roster version it verified. Afterwards it accepts that teammate's Devices only when a roster
signed by the pinned identity lists them, and refuses roster rollback.

Because the AMK never changes, a changed account identity for a pinned teammate is never routine.
The client treats it as a hard warning: that teammate's Devices are not trusted, the client sends
them no keys (grants, Membership provisioning), and their Revisions do not verify, until the user
explicitly re-trusts the new identity after comparing fingerprints out of band.

The **fingerprint** is the first 20 bytes of SHA-384 over the identity, in five groups of eight
lowercase hex characters. It appears in `dotrelay team members --fingerprints` and in the web
Members view. `dotrelay team trust <user-id>` and the Members view re-trust a changed identity.

## What the roster replaces

Verified-roster keys replace every service-supplied key list:

- Revision signing trust: a `signingTrustDevices` entry is kept only when its User's roster lists
  that Device with the same Ed25519 key. Its window ends no later than the roster's revoked-at.
  Membership windows still come from the service; Membership is authorization, not keys.
- Grant and Account Key object signature trust sets.
- Own peer Devices that receive the Project Epoch Key (`peerDevices`).
- Membership provisioning recipients: every Device in the plan must be an active roster Device
  with the same X25519 key. A plan with any other Device is refused.
- Project Epoch Key Link signatures (ADR 0014).

User-defined Values are already sealed to the User Value Key behind the AMK; no Device list feeds
them.

## Limits

Adding a Device is still a user decision made on what the service shows. A new Device is never in
the roster before it holds the AMK, so the AMK handoff to it (dual-control enrollment approval,
Account Key Transfer to a chosen Device, Recovery Code restore) cannot be gated on the roster.
Those flows keep their existing checks (enrollment transcript and challenge, the user choosing the
target, the Recovery Code proof). The roster protects every key decision after that: once the new
Device publishes its own entry, nothing else can join without a client that holds the AMK. A
stronger ceremony, such as comparing the new Device's key fingerprint during approval, is left
for a later ADR.

Membership windows (when someone joined or left a Team) still come from the service.

## Migration

The first client after upgrade that holds a User's AMK publishes that User's version-1 roster: the
User's active Devices and the Devices the service reports as revoked, with their reported
revocation times. This is trust on first use at upgrade, and it is the only point at which
service-reported Devices enter a roster without a client having seen them.

Until a User has a roster, clients keep today's behaviour for that User's Devices and flag the
User **unverified** in the CLI and web. A pinned teammate whose roster disappears is treated as a
rollback, not as unverified. The window closes per User as soon as any of their clients with the
AMK runs.

## Consequences

- The service can still withhold rosters or deny service; it can no longer add or swap Device keys
  for a User whose roster a client has pinned.
- Teammate pins are per client. A client that loses state pins teammates again on first sight.
- Protocol registry, validation, OpenAPI and vectors change together; ship API, web and CLI
  together.
- A new migration adds `account_device_rosters`.
