# Device display metadata is cleartext and outside the certificate

Status: accepted

Devices are identified by opaque UUIDs. Operators and peers need a
human-readable label (hostname or browser summary) plus client kind, OS,
and a short client summary so the Devices table and recovery target picker
do not force people to compare bare ids.

## Decision

- Device display metadata (`displayName`, `nameOverridden`, `clientKind`,
  `osName`, `clientSummary`) is plain JSON stored on the Device row. It is
  **never** written into the signed Device certificate or any protocol
  object.
- The owning Device refreshes un-overridden auto names on each session via
  `POST /api/v1/devices/self`. A rename (`displayName`) sets
  `nameOverridden` so later describes stop clobbering it; `resetName`
  returns the Device to auto-naming.
- Values are cleartext on the Server Profile: anyone who can list the
  User's Devices already sees public keys and ids; hostname/OS labels add
  no content-key material.

## Rationale

- Putting labels in the certificate would change certificate fields,
  signatures, and every client that verifies them for a non-security
  property.
- Cleartext labels match the existing boundary model: display-only
  metadata for the User's own Devices, not encrypted Shared Values.
- Nullable columns let existing rows migrate without backfill; clients
  refresh on their next session.

## Consequences

- Migration `20260924120000_device_display_metadata` adds the columns and
  the `DeviceClientKind` enum.
- Boundary responses include optional `name` / `clientKind` / `osName` /
  `clientSummary` on `device` and each `peerDevices` entry.
- Bootstrap and dual-control complete accept a `client` object parsed by
  `parseDeviceClientInfo` (shared in `@dotrelay/contracts`).
