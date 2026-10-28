# Session-bootstrapped Devices are fully active

Status: accepted

DotRelay provisions a User's first Device through initial trust bootstrap
(`DeviceRepository.completeBootstrap`), which commits a Device certificate
protocol object and creates the Device as `ACTIVE` without any dual-control
enrollment record. This ADR records that a session-bootstrapped Device is a
fully active Device, not a limited or pre-recovery state, that bootstrap is
first-Device-only, and fixes the contradiction in the trust and CLI
documentation that described dual-control enrollment as if it were a
requirement for a Device to become usable.

## Decision

A Device created by `completeBootstrap` is `ACTIVE` for every purpose that an
enrolled Device is: it satisfies the `requireActiveDevice` gate, so the User
can act with it on its own behalf, and it may approve a dual-control
enrollment initiated by a different Device. `PENDING` exists only for a
Device whose dual-control enrollment is still in flight; there is no separate
"limited" or "bootstrap-only" lifecycle state.

## Bootstrap is first-Device-only

`completeBootstrap` creates at most one `ACTIVE` Device per User at a time.
Under the per-User row lock, after the idempotent-replay early return, it
counts the User's `ACTIVE` Devices and rejects the bootstrap with "a device
has already been bootstrapped; use enrollment to add another device" when the
count is nonzero. Additional Devices therefore join exclusively through
dual-control enrollment, whose `beginEnrollment` gate already requires at
least one `ACTIVE` Device. The two gates are complementary: a User with zero
`ACTIVE` Devices can only bootstrap, and a User with at least one can only
enroll (with a different Device approving, since initiator and approver must
differ).

- A byte-identical retry of an already-committed bootstrap returns
  idempotent before the count check, so the restriction never rejects a
  replay.
- A revoked Device is not counted: a User whose only Device was revoked can
  bootstrap again, which keeps the bootstrap path usable as a fresh start.

## Rationale

- The account-level trust boundary is the Account Master Key, not Device
  provenance. A Device that has never recovered the AMK decrypts nothing; an
  `ACTIVE` Device holding no AMK and no key grants grants no extra access to
  Project or User Value content. Device lifecycle therefore does not need to
  model "how the Device arrived", only whether it is usable (`ACTIVE`) or
  retired (`REVOKED`).
- ADR 0009 (Account Master Key with optional recovery wrappers) makes the
  recovery-code flow a first-class, headless-capable path to the AMK.
  Requiring a second Device to approve the first Device would reintroduce the
  two-device requirement that the recovery design removes: a single lost
  machine with no Recovery Code could not even approve its own replacement.
- Bootstrap trades the dual-control signature exchange for an authenticated
  session. That trade is justified only for a User who has no other Device to
  cross-check against; once a trusted Device exists, a new Device should
  demonstrate possession of keys that an existing Device has vouched for.
  Restricting bootstrap to the first Device closes the gap where a user who
  already trusted a Device could bootstrap a second one without any peer
  approval.
- The dual-control enrollment gate is enforced exactly where it must be:
  `beginEnrollment`, `approveEnrollment`, and `completeEnrollment` each run
  `requireActiveDevice`, and `approveEnrollment` rejects an approver that is
  the same Device as the initiator. Bootstrap Devices satisfy the same
  "active" gate as enrolled Devices, so the authorization layer is consistent
  without a special case.

## Consequences

- `DeviceRepository.completeBootstrap` continues to create Devices as
  `ACTIVE` and now enforces the first-Device restriction. No migration is
  required; this ADR aligns the documentation and the trust integration suite
  with the enforced behavior.
- `docs/wiki/trust.md` and `docs/wiki/cli.md` describe bootstrap Devices as
  fully active and bootstrap as first-Device-only. Dual-control enrollment is
  documented as the only path for additional Devices, not as a gate that a
  bootstrap Device must pass before it can act.
- `trust.integration.test.ts` pins the behavior: bootstrapping the first
  Device succeeds, a second bootstrap for the same User is rejected, and a
  byte-identical replay of the committed bootstrap returns idempotent. A
  session-bootstrapped Device is `ACTIVE` and can approve an enrollment that
  a different Device initiated.
