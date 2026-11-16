# Lanes are bound to their Revision, and first sight cannot bring a Value back

Status: accepted; amends [ADR 0022](0022-client-trust-anchors-and-key-adoption.md).

ADR 0022 lets a teammate pinned on first sight verify history because "a Revision that decodes
needs the Project Epoch Key". That argument holds only if every lane a Revision carries was sealed
for that Revision. Both lane formats put the lane's own Revision id (field 16) into the AES-GCM
associated data, but nothing checked that field 16 named the Revision carrying the lane, or that a
Revision id appeared once in a history. Clients also verified Revisions with plain keys when the
service sent no signing-Device entries, which binds no author to the key. Under those gaps a
signer holding no Project key could make an Environment present a Value that a later Revision had
replaced. Legacy (format 1) lanes add a second gap: their associated data binds no Environment,
owner or provider.

This ADR closes both by making the binding a verification rule, and records how first-sight
teammates are limited.

## Decision

### A lane speaks only for the Revision that carries it

- Every lane (kind 13) and the Manifest descriptor (kind 15) of a Revision must carry the
  Revision's Server Profile (8), Team (11), Project (13), Environment (14) and Revision id (16).
  `verifySyncPage` refuses a Revision that carries anything else. Because both lane formats bind
  field 16 into the ciphertext, a lane sealed for another Revision either fails this check or
  fails to decrypt.
- Every Revision must name the Server Profile, Team and Project the client synced it for
  (`expectedContext`), and the Environment of the page, as before.
- The service applies the same check at publication, as a consistency check for an honest
  service. It also refuses new format-1 lanes: every current client writes format 2.

### A Revision id appears once in a history

`verifySyncPage` refuses a Revision whose id equals the Environment id (the genesis anchor), the
trusted starting point, an earlier Revision of the page, or an id the client says it verified
before (`knownRevisionIds`). The CLI replays from genesis, so the page holds every id. The browser's
incremental sync after a stale head passes the ids of its verified history, with the starting
Revision's authored-at instant and Project epoch.

### History signers are bound to their authors

Clients verify Revisions only through signing-trust entries that name the signing Device and its
User, built from roster-verified Devices (ADR 0015). When the service sends no entries, a client
trusts only its own Device's key for its own User and Device. A teammate's plain key never verifies
history. `verifySyncPage` keeps accepting plain keys for tools and tests, but refuses a legacy
User-defined Value lane in a Revision that no author-bound entry authorized.

### First sight: history yes, old or legacy Values no

A teammate pinned on first sight still verifies history; requiring confirmation first would break
persistent CI runners, as ADR 0022 says. With the rules above, a Revision changes a Value only
through a lane sealed for that Revision under a key its author holds. An unconfirmed author who
holds no key can therefore withhold or break an Environment, which the service can do anyway, but
cannot make a client present a Value the history already replaced.

Legacy lanes are the exception, because they bind no Environment. A client applies a format-1 lane
only when its Revision's author is the client's own User or a teammate the user confirmed on this
installation. A format-1 lane from any other author is not applied: the Variable's state at that
Revision is unknown, and if no later Revision replaces it the read fails with
`UnreadableLaneError` (reason `unconfirmed-legacy-author`, naming the author). The CLI answers
`unconfirmed_legacy_lane`; the web editor explains the same. Confirming the author's fingerprint,
or publishing the Value again (which writes format 2), clears it.

## Considered options

- **Refuse format 1 for every read.** Simplest, but every legacy Value, including the account's
  own, would be unreadable until republished.
- **Only mark Values by unconfirmed authors** in `pull`, `run` and the editor. The client would
  still apply them, and nobody reads a warning in CI.
- **Confirm every teammate before their history verifies.** Breaks persistent CI runners whenever
  a teammate joins (ADR 0022).
- **Refuse copied ciphertexts by hash.** Gives the same protection as binding plus unique ids on a
  full replay and needs stored hashes for incremental syncs.
- **Bind the parent Revision hash in a future lane format.** Would make the known-id list
  unnecessary for incremental syncs; left for the next protocol revision.

## Consequences

- Honest history is unaffected: every client has always written a lane's fields 8, 11, 13, 14 and
  16 from the Revision that carries it, and Revision ids are random.
- A Server Profile that sends no signing-Device entries leaves a client unable to verify any
  Revision but its own. That is the intended failure: it never falls back to plain keys.
- Shared Values and definitions a teammate wrote before lane format 2 read only on installations
  that confirmed that teammate (`dotrelay team trust`, **Confirm fingerprint** in Members), until
  someone publishes them again. A CI runner confirms non-interactively with
  `dotrelay team trust <user-id> --fingerprint <fingerprint> --no-input`.
- A client from before lane format 2 can no longer publish: the service refuses its format-1
  lanes. Ship the API, web and CLI together.
- Residual risks are unchanged: a malicious service can still withhold Revisions, fork or freeze
  history without a witness, and a confirmed teammate is trusted with legacy lanes because they
  hold the Project key.
