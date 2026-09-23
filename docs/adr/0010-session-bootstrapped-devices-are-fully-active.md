# Session-bootstrapped Devices are fully active

Status: accepted

DotRelay provisions a User's first Devices through initial trust bootstrap
(`DeviceRepository.completeBootstrap`), which commits a Device certificate
protocol object and creates the Device as `ACTIVE` without any dual-control
enrollment record. This ADR records that a session-bootstrapped Device is a
fully active Device, not a limited or pre-recovery state, and fixes the
contradiction in the trust and CLI documentation that described dual-control
enrollment as if it were a requirement for a Device to become usable.

## Decision

A Device created by `completeBootstrap` is `ACTIVE` for every purpose that an
enrolled Device is: it satisfies the `requireActiveDevice` gate, so the User
can act with it on its own behalf, and it may approve a dual-control
enrollment initiated by a different Device. `PENDING` exists only for a
Device whose dual-control enrollment is still in flight; there is no separate
"limited" or "bootstrap-only" lifecycle state.

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
- The dual-control enrollment gate is already enforced exactly where it must
  be: `beginEnrollment`, `approveEnrollment`, and `completeEnrollment` each
  run `requireActiveDevice`, and `approveEnrollment` rejects an approver that
  is the same Device as the initiator. Bootstrap Devices satisfy the same
  "active" gate as enrolled Devices, so the authorization layer is consistent
  without a special case.

## Consequences

- `DeviceRepository.completeBootstrap` continues to create Devices as
  `ACTIVE`. No migration or authorization change is required; this ADR aligns
  the documentation and the trust integration suite with the behavior the
  code already has.
- `docs/wiki/trust.md` and `docs/wiki/cli.md` describe bootstrap Devices as
  fully active. Dual-control enrollment is documented as the path for a
  Device whose keys are generated on an already-enrolled installation, not as
  a gate that a bootstrap Device must pass before it can act.
- `trust.integration.test.ts` pins the behavior: a session-bootstrapped
  Device is `ACTIVE` and can approve an enrollment that a different Device
  initiated.
