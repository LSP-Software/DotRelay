# Conflicts on another User's Value offer keep remote only

Status: accepted

When a Variable Conflict involves a User-defined Value whose remote Value is owned by another
User, the CLI prompt states that fact and offers keep remote only. Choosing keep local on a Value
the operator cannot read would not reconcile two known Values; the published lane is sealed to the
actor's key and stamped `ownerUserId = actor`, transferring ownership of the teammate's Value. The
client's decode therefore surfaces the Value lane's owner (already carried on the wire) so the
prompt can tell the operator whose side is whose. Keep remote requires no reading of the remote
Value at all: the lane is simply omitted and the remote state carries over in the chain fold. The
conflict path is the scope; a non-conflicting push can still transfer ownership of a
teammate-owned Value as before, which is recorded as a follow-up candidate rather than widening
issue #88.

## Considered options

- Offer local/remote unchanged: identical to today's lane model, but leaves an ownership claim
  dressed up as a reconciliation in the one path this issue makes interactive.
- Warn but still allow keep local: explicit, yet the act remains one keystroke away on a
  security-relevant Value.
