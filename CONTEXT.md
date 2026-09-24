# DotRelay

DotRelay is a collaboration context for sharing revisioned environment configuration without
revealing its human-readable content to the service that synchronizes it.

## Language

**User**:
A person represented by a DotRelay identity within one Server Profile who may hold Memberships and
authorize Devices. The same person on another Server Profile is a distinct User.
_Avoid_: Account, developer

**Device**:
A client installation authorized by exactly one User to access that User's DotRelay data. Each
Device carries optional cleartext display metadata (auto or user-renamed name, CLI vs browser, OS,
client summary) for labels only; it is never part of the signed Device certificate.
_Avoid_: Session, computer

**Account Master Key (AMK)**:
The random 256-bit key that anchors all of one User's encryption within one Server Profile. Every
Project Epoch Key and User Value Key is wrapped by the User's AMK, so a Device that recovers the
AMK can recover the content keys and decrypt the User's data. It is never stored or transmitted by
the service and never differs by recovery method.
_Avoid_: Master password, account password, encryption key

**Account Key Wrapper**:
A service-stored, Device-signed encryption of the Account Master Key under a key derived from one
User-held secret. Wrappers protect exactly the same AMK regardless of type and may be added,
changed, or retired without touching the AMK or any encrypted Value.
_Avoid_: Recovery key, backup key, encryption credential

**Passkey Wrapper**:
An Account Key Wrapper whose key derives from a WebAuthn passkey's PRF output. Optional; the
product never requires a passkey or WebAuthn PRF support to create an account, unlock data, or
recover from Device loss.
_Avoid_: Required 2FA, security key requirement

**Encryption Password**:
A User-chosen secret, distinct from the GitHub and Better Auth credentials, that exists solely to
unlock the User's encrypted DotRelay data by wrapping the Account Master Key. It never authenticates
the User to the service and never leaves the client that derives its key.
_Avoid_: Master password, login password, sign-in password

**Recovery Code**:
The user-held, human-readable, 256-bit emergency secret behind the universal disaster-recovery
Account Key Wrapper. Generated client-side, shown once, and never stored by the service; it stays
available even when every Device and every other wrapper is lost.
_Avoid_: Backup password, recovery key file, master password

**Recovery Code Rotation**:
Creating a new `RECOVERY_CODE` Account Key Wrapper that wraps the same Account Master Key and, only
after the service accepts it, retiring the prior recovery wrapper so the old code stops working.
_Avoid_: Code refresh, backup update

**Account Key Envelope**:
A service-stored, Device-signed encryption of a content key (Project Epoch Key or User Value Key)
by the User's Account Master Key. Devices that hold the AMK use it to recover content keys after
recovery, so no existing Device is needed to read previously published data.
_Avoid_: Key grant, key backup

**Account Key Transfer**:
A one-time, ciphertext-only handoff of the Account Master Key from an unlocked Device or browser
to a new Device's X25519 key, relayed by the service. It underpins CLI login and trusted-Device
approval; the service relays ciphertext and never sees the AMK.
_Avoid_: Session handoff, key sync

**Team**:
The collaboration and authorization boundary whose active Members share access to all of its
Projects.
_Avoid_: Group, organization, workspace

**Membership**:
The relationship between one User and one Team, carrying an owner, admin, or member role and an
access lifecycle.
_Avoid_: Seat, access grant

**Membership Invitation**:
A single-use, expiring invitation addressed to a stable GitHub identity. Acceptance by the matching
User creates a Membership that remains pending until its required key grants are provisioned.
_Avoid_: Invite link, seat invitation

**Member**:
A User whose Membership in a Team is active.
_Avoid_: Collaborator, teammate

**Project**:
A Team-owned secret-sharing space linked to one GitHub Repository and containing named
Environments.
_Avoid_: Repository, workspace

**GitHub Repository**:
The external source repository, identified by its stable GitHub identity, that identifies a Project
to clients but does not grant DotRelay access.
_Avoid_: Project

**Repository Identity**:
The stable GitHub-side identifier of a GitHub Repository that does not change when the repository
is renamed or transferred, unlike its descriptive owner/name.
_Avoid_: Full name, repository name, slug

**Repository Linkage**:
The stable association between a Project and one Repository Identity, established through a
deliberately supported user-authorized path and remaining valid while live GitHub data is
unavailable.
_Avoid_: Repository binding, repo link

**Delegated GitHub Access**:
The fine-grained GitHub authorization a User grants to the service at sign-in, covering only the
repositories the User selects, which lets the service resolve Repository Identities and verify
repository access on the User's behalf; clients never send or store it.
_Avoid_: GitHub token, OAuth token, API key

**Repository Resolution**:
The service-side resolution of a repository's descriptive owner/name to its Repository Identity
on the acting User's behalf through their Delegated GitHub Access, returning an access verdict
or a classified failure.
_Avoid_: Repository lookup, identity check

**Repository Choice**:
The explicit selection of which Git remote identifies a worktree's GitHub Repository when remotes
name different repositories, such as a fork `origin` and a source `upstream`; it is stored in the
worktree context as opaque identifiers and re-used until that remote stops pointing at the same
repository, and it never grants access beyond the Project that identity identifies.
_Avoid_: Remote switch, repository toggle

**Canonical Rename**:
A GitHub rename or transfer that changes a repository's descriptive owner/name while its
Repository Identity stays the same, so an existing Repository Linkage must continue to apply.
_Avoid_: Repository move, relocation

**Environment**:
A revisioned, named configuration scope within a Project, such as development, staging, or
production.
_Avoid_: File, stage

**Manifest**:
The complete logical encrypted content of an Environment at a Revision: its Environment definition,
Variable definitions, Shared Values, and User-defined Values.
_Avoid_: Env file, payload

**Variable**:
A named Manifest entry with an optional description and either shared or user-defined value
ownership.
_Avoid_: Key, secret

**Shared Value**:
A Variable's Team-readable Value whose original provider and Team admins may change or roll back
it.
_Avoid_: Global value, common value

**User-defined Value**:
A User-owned Value required by a Variable and readable only by that User's authorized Devices.
_Avoid_: Personal value, local value

**Revision**:
An immutable recorded state of an Environment's Manifest.
_Avoid_: Version, snapshot

**Rollback**:
A new Revision that restores content from an earlier Revision without deleting intervening
history.
_Avoid_: Revert, restore, delete

**Publication**:
The client operation that stages signed lanes for a Manifest's changed Variables and submits a new
Revision against an expected head; a Variable the Publication does not mention keeps the state it
held in the parent Revision.
_Avoid_: Commit, push, upload

**Draft**:
An unpublished, client-held set of intended Variable changes derived from a Publication Baseline;
it is not a Revision and the Server Profile never sees it.
_Avoid_: Working copy, pending change, WIP

**Publication Baseline**:
The verified Revision from which a Draft's content was derived; a publication built from a Draft
must reconcile that Baseline, the Draft, and the Environment's current Manifest before it may be
accepted against a newer head.
_Avoid_: Expected head, base revision, anchor

**Baseline Reconciliation**:
The three-way comparison of a Publication Baseline, a Draft, and an Environment's current Manifest
that yields the merged publication content and the Variable Conflicts requiring a human choice.
_Avoid_: Sync, three-way merge, bare reconciliation

**Variable Conflict**:
A Variable changed in both a Draft and the Environment's current Manifest relative to the Draft's
Publication Baseline, where the two results diverge; it blocks publication until a person chooses
the Draft's state, the remote state, or a merge of them.
_Avoid_: Collision, merge conflict, stale head

**Server Profile**:
A named hosted or self-hosted DotRelay service selected by a client. A web deployment is bound to
the Server Profile behind it and never lets a visitor choose another; only the CLI selects among
Server Profiles.
_Avoid_: Instance, endpoint

**History Trust Reset**:
An explicit acknowledgement that discards one Environment's locally trusted Revision continuity
after a known service restore without recovering its missing history.
_Avoid_: Rollback, profile reset, automatic resynchronization

**Application Diagnostic Event**:
A non-durable, structured record of service behavior used for operational diagnosis without
protected content, domain identifiers, or disallowed metadata.
_Avoid_: Log line, telemetry payload

**Correlation ID**:
A random, non-domain identifier that links diagnostic records for one request or bounded internal
execution without identifying a User, Device, Team, Project, Environment, Variable, Revision, or
GitHub Repository.
_Avoid_: Operation id, domain id

**Security Request Log**:
A short-retention record of the allowlisted request metadata needed for security investigation;
it is separate from an Application Diagnostic Event and a durable Audit Fact.
_Avoid_: Access log, audit log

**Audit Fact**:
A durable record of a successful security or domain change containing only the approved opaque
actors, affected entities, lifecycle change, receipt time, and immutable outcome references.
_Avoid_: Debug log, event stream

**Diagnostic Field Allowlist**:
The small set of typed operational fields permitted in an Application Diagnostic Event; it is the
boundary that redaction and serialization must not expand.
_Avoid_: Log context, arbitrary metadata

**Diagnostic Event Schema**:
The versioned fixed envelope and event names used by Application Diagnostic Events, carrying only
the Diagnostic Field Allowlist and no free-form diagnostic content.
_Avoid_: Ad hoc log format, exception dump

**Cryptographic Suite**:
The single closed set of algorithms, encodings, and protocol rules that protects DotRelay protocol
objects and encrypted Values for one release line.
_Avoid_: Provider, algorithm option, compatibility mode
