# Protect the Account Master Key with optional recovery wrappers

Status: accepted

DotRelay v3 protects each User's encrypted data with a single Account Master Key (AMK): a random
256-bit key bound to the User and the Server Profile. The AMK is the only account-level secret.
Project Epoch Keys and User Value Keys are 256-bit keys wrapped by the User's AMK and stored on
the service as Account Key Envelopes, so every Device of the User that can recover the AMK can
recover the content keys and decrypt the same Manifest content. No encryption identity, User
Value Key, or Project key ever differs by recovery method.

The service stores only AMK-wrapped ciphertext and wrapper metadata. It never stores the AMK
plaintext, an encryption password, a password-derived key, a WebAuthn PRF output, or a Recovery
Code. Authentication (GitHub through Better Auth) establishes only who the User is; it can never
decrypt or reproduce the AMK. An attacker who steals the service database gains encrypted wrappers,
salts, KDF parameters, credential metadata, and envelopes, none of which reveal the AMK without
one of: a passkey's PRF secret, the encryption password, the Recovery Code, or an already-authorized
Device's local secret.

## Wrappers

Every way the User can recover the AMK is an Account Key Wrapper: an AES-256-GCM encryption of
the same AMK under a KEK derived from a User-held secret. Wrapper types:

- `PASSKEY_PRF` (optional): a WebAuthn assertion's PRF output for a stored PRF input, expanded by
  HKDF-SHA-384 into the KEK. Passkey support is a convenience, not a requirement: account
  creation and recovery never depend on WebAuthn or PRF support, and a normal assertion without
  PRF output is never accepted as a passkey wrapper.
- `PASSWORD` (optional): an independent DotRelay encryption password, unrelated to the GitHub or
  Better Auth credential, expanded through the memory-hard KDF Argon2id (parameters persisted per
  wrapper) and then HKDF-SHA-384 into the KEK. A wrong password fails as one uniform
  "could not unlock" error; the wrapper is guessable offline if stolen, which is why the KDF must
  stay memory-hard and the password strong.
- `RECOVERY_CODE` (always present): a 256-bit, client-generated, human-readable code expanded
  through HKDF-SHA-384 into the KEK. It is the universal disaster-recovery route, shown to the
  User once at creation and rotation, and never stored by the service.

At least one unrevoked wrapper must always exist, and among them at least one `RECOVERY_CODE`
wrapper. Users may hold any other combination of `PASSKEY_PRF` and `PASSWORD` wrappers; adding,
changing, or removing a wrapper re-wraps the same AMK and never rotates the AMK, Project Epoch
Keys, or User Value Keys.

## Recovery paths for a new Device

A new Device (browser or CLI) authenticates through Better Auth, bootstraps its own Device keys,
and then recovers the AMK by exactly one of:

- any unrevoked wrapper: a passkey assertion or the encryption password, performed in a browser
  for both browser and CLI Devices (the browser never transmits the User's secret), or the
  Recovery Code, which a browser or CLI Device fetches as the wrapper and unwraps locally,
- approval by an existing trusted Device, which seals the AMK to the new Device's X25519 key.

The existing-Device path is a convenience, never the only route: a User who loses every Device
recovers with a passkey, an encryption password, or the Recovery Code. No flow ever requires two
existing Devices, and no flow transmits the AMK in plaintext through the service; a trusted
Device or an unlocked browser sends only ciphertext sealed to the new Device's key.

## Supersedes the Recovery Kit

The client-file Recovery Kit (Recovery Envelope, Recovery plaintext bundle, Recovery challenge
proof, recovery grants, and `/api/v1/recovery/*`) is retired. The `dotrelay device backup` and
`dotrelay device recover` commands are repurposed: backup creates a `RECOVERY_CODE` Account Key
Wrapper, and recover unlocks a Device with a Recovery Code or by accepting an Account Key
Transfer. The Recovery Code wrapper is the single disaster-recovery mechanism: it is
service-visible as an ordinary Account Key Wrapper, rotates by creating a new wrapper and
retiring the prior one only after the new wrapper is committed, and needs no file artifact or
replacement-Device key ceremony. The `users.recoveryGeneration` column is removed: the active
`RECOVERY_CODE` wrapper is identified by its wrapper id, and rotating the code simply retires
the old wrapper and commits a new one.

## Identity and transfer retry

First establishment is a different transition from recovery-code rotation. A
client that observes no active wrapper publishes with intent `establish`. The
service locks the user row and inserts that wrapper only when the account
still has none. A second establishment fails, leaves the winner untouched, and
the losing device discards its candidate and recovers the winner. Rotation is
the explicit `rotate` intent, and it is the only path that retires the previous
recovery code. Passkey and password wrappers use `add` and do not retire the
recovery code.

One active Project Epoch Key envelope exists for each `(user, project, epoch)`,
and one active User Value Key envelope for each `(user, owner, generation)`.
A byte-identical retry of that ciphertext is idempotent. A different ciphertext
for the same identity is rejected. The migration that adds the unique indexes
reports existing duplicate protocol object ids and stops; it does not delete
rows.

Accepting an Account Key Transfer marks it delivered and returns the ciphertext.
The same recipient can accept again until it signs an acknowledgement or the
transfer expires. Acknowledgement is the transition that makes the transfer
unusable. Expiry and recipient revocation fail closed and do not return the
ciphertext.

User-defined Values are sealed to the User Value Key, not to the publishing
Device and not to the Project Epoch Key. The first unlocked Device of the
owner publishes one generation-1 envelope. Another Device of that owner opens
the same envelope after it recovers the Account Master Key, then decrypts the
Value. Team-shared Values stay on the Project Epoch Key. A `creatorPublicKey`
returned beside an object is not added to the trust set unless that key is
already in the Device trust history.
