# DotRelay

DotRelay is a collaboration context for sharing revisioned environment configuration without
revealing its human-readable content to the service that synchronizes it.

## Language

**User**:
A person with a DotRelay identity who may belong to Teams and authorize Devices.
_Avoid_: Account, developer

**Device**:
A client installation authorized by a User to access that User's DotRelay data.
_Avoid_: Session, computer

**Recovery Kit**:
A user-held recovery secret that can authorize a replacement Device when no existing Device is
available.
_Avoid_: Backup password, master password

**Team**:
The collaboration and authorization boundary containing Members and Projects.
_Avoid_: Group, organization, workspace

**Member**:
A User participating in a Team with an owner, admin, or member role.
_Avoid_: Collaborator, teammate

**Project**:
A Team-owned secret-sharing space linked to one GitHub Repository and containing named
Environments.
_Avoid_: Repository, workspace

**GitHub Repository**:
The external source repository that identifies a Project to clients but does not grant DotRelay
access.
_Avoid_: Project

**Environment**:
A named configuration scope within a Project, such as development, staging, or production.
_Avoid_: File, stage

**Manifest**:
The complete set of Variable definitions and Values for an Environment at a Revision.
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
