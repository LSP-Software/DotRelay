# One baseline reconciliation contract for both clients, in @dotrelay/client

Status: accepted

The three-way reconciliation of a Publication Baseline, a Draft, and an Environment's current
Manifest — including convergence (both sides reaching the identical state is not a conflict),
Variable Conflict detection, and the resolution choices (keep the Draft's state / keep the remote
state, plus merge of remote definition with local value for definition conflicts) — lives in the
shared `@dotrelay/client` protocol package. The CLI adopts it in the issue #88 change; the web
client, which today uses a two-way changed-lane heuristic with no baseline convergence check,
migrates in a follow-up so both clients share one contract.
