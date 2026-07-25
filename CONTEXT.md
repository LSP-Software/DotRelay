# DotRelay

DotRelay is a collaboration context for sharing revisioned environment configuration without
revealing its human-readable content to the service that synchronizes it.

## Language

**User**:
A person represented by a DotRelay identity within one Server Profile who may hold Memberships and
authorize Devices. The same person on another Server Profile is a distinct User.
_Avoid_: Account, developer

**Device**:
A client installation authorized by exactly one User to access that User's DotRelay data.
_Avoid_: Session, computer

**Recovery Kit**:
A user-held recovery secret that can authorize a replacement Device when no existing Device is
available.
_Avoid_: Backup password, master password

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

**Server Profile**:
A named hosted or self-hosted DotRelay service selected by a client.
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
