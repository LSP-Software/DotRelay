# Account-level actions need a Device, and account deletion its signature

Status: accepted; amends [ADR 0018](0018-account-deletion-keeps-public-verification-material.md)
and [ADR 0019](0019-leaving-and-deleting-a-team.md).

ADR 0018 made account deletion session-only so that a User who lost every Device could still
delete, and ADR 0019 made leaving a Team session-only so that a Member still waiting for keys could
leave. ADR 0020 then made Device authority rest on the Device key, and the authentication wiki says
a session never grants mutation permission. A session is the easiest credential to lose: it comes
from a device-code approval or a CLI bearer token. With it alone, deletion removed every Account
Key Wrapper, so the User's User-defined Values became unrecoverable, and leaving ended Memberships.
The account export, also session-only, lists every Device and the address and browser of every
session.

## Decision

### Who may act for the account

Deleting the account, leaving a Team, and exporting account data require **account authority**:

- While the User has at least one active Device, the request proves one of them with a Device
  proof (ADR 0020). Without one it is `401 device_proof_required`, whatever else it carries.
- A User with no active Device has nothing to prove, so the session must come from a sign-in in
  the last ten minutes. An older session is `403 recent_sign_in_required` (a new problem code).

Reading the deletion plan stays session-only: it names only Teams the session can already list.
Deleting a Team already needed a Device proof (ADR 0019) and is unchanged.

### Account deletion is signed

Like a Device revocation, account deletion carries the proven Device's Ed25519 signature over the
exact command the service records:

```text
UTF-8 JSON {"action":"account.delete","userId":<confirmUserId>,"operationId":<Idempotency-Key>}
```

`accountDeletionCommand` in `@dotrelay/contracts` builds it for the API, the CLI and the browser.
The service verifies it with the key it stored for the proven Device, and refuses a missing
signature (`400 invalid_request`) or one that does not verify, including one made for another
operation (`400 invalid_crypto_object`). So a session with a copied Device proof, which is a bearer
token for five minutes, still cannot delete the account: that needs the Device key itself, at the
moment of deletion and for this one operation. A User with no active Device sends no signature.

The typed confirmation stays: clients ask for `delete my account` before they sign, and the body
repeats the User id.

## Considered options

- **A server-issued deletion confirmation token.** A second round trip that a holder of the session
  and a live proof could also complete; the Device signature binds the action to the key instead.
- **A grace period or an emailed confirmation link.** Email is optional per Server Profile, and a
  pending deletion still holds every credential (ADR 0018 rejected a grace period for that reason).
- **The Recovery Code instead of a recent sign-in** for a User without a Device. It would protect
  that case better, but a User who lost every Device restores one with the Recovery Code anyway
  (ADR 0013), after which the Device path applies.

## Consequences

- A User whose Devices are all lost but still active cannot delete from a session alone. They
  restore a Device with the Recovery Code (or a transfer from another Device) and delete from it.
  A User with no Recovery Code and no Device asks the operator.
- A device-code approval obtained by phishing no longer deletes an account, removes it from its
  Teams, or exports its session history, as long as the account has an active Device. An account
  whose Devices are all revoked is still exposed to a fresh phished session; that is the same
  window as bootstrap without an active Device (ADR 0010).
- The web app passes its Device to these requests and signs deletion with the Device key in its
  store; the CLI proves its Device for `team leave`, `account export` and `account delete` and signs
  deletion with its stored key. A CLI whose stored Device was revoked sends neither; the
  service then accepts the action only from a recent sign-in of an account with no other active
  Device. API, web and CLI ship together.
