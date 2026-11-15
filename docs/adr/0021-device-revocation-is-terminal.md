# Device revocation is terminal

Status: accepted

Clients judge every Revision a Device signed by the Device's activation and revocation times. Those
times must therefore never change once set. `DeviceRepository.beginEnrollment` could reuse an
existing `REVOKED` row as a prospective Device, which moved it back to `PENDING` and cleared both
times; the Revisions the Device had signed would then no longer verify.

## Decision

`REVOKED` is a terminal Device lifecycle state.

- `beginEnrollment` accepts an existing row only while it is `PENDING`, and only when its User,
  identity generation and both public keys equal the request's. A `REVOKED` or `ACTIVE` row is a
  `state_conflict`. Enrollment begin never writes `activatedAt` or `revokedAt`.
- A database trigger on `devices` enforces the same invariant for every writer. A `REVOKED` row
  cannot change lifecycle, `activatedAt` or `revokedAt`. No row may move back to `PENDING`. Once
  set, `activatedAt` and `revokedAt` never change. The User, identity generation, key id and
  public keys of a Device never change. Display metadata (ADR 0012) stays writable.

A Device's verification window is therefore written once: `activatedAt` when it first becomes
`ACTIVE`, `revokedAt` when it is revoked. Clients and the service read both from the row.

## Consequences

- Re-enrolling a machine after revocation needs a new Device id and new keys. The CLI and the
  browser already generate both for every enrollment and bootstrap, so no client changes.
- A User whose only Device was revoked can still bootstrap a new Device (ADR 0010), because
  bootstrap creates a new row.
- Expired `PENDING` rows stay as they are. They hold no keys a client trusts, the boundary does
  not list them, and they cannot sign anything.
