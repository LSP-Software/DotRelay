# Clients take trust only from what the service cannot forge

Status: accepted

ADR 0015 put each account's Device keys on a roster signed by the account key. This ADR decides
where the clients anchor their other trust decisions: which Devices a client trusts for history
and for keys, which Project Epoch Key it adopts, how a new Device receives the Account Master Key,
and what a sync page and a ciphertext lane may claim. Each decision rests on something the service
cannot produce by itself: an object signed or sealed under an account key, a value the person
carried between their own screens, or a decision this installation already recorded. The
Consequences list the decisions that still rest on the service.

## Decision

### No trust from absent data

- Account trust resolves every User a key list names, not only the Users in the roster map. A
  User without a roster this client can verify contributes no Device. A pinned User whose roster
  is missing, null or older is a rollback and blocks.
- The own account is anchored by the identity derived from the AMK, or by the own pin. Without
  either, a client trusts only its own Device. A locked Device therefore cannot accept a grant from
  another Device of its account; it unlocks first.
- A Device enters the roster only as the publishing Device itself, or as a Device the user
  approved on the publishing Device: an enrollment it approved, or a transfer target whose key
  fingerprint the user confirmed. The service's Device report never adds a Device, not even to a
  first roster. It is still used to mark listed Devices revoked.

### First sight is pinned for history, confirmed for keys

A teammate seen for the first time is pinned, so later swaps and rollbacks are caught, but the pin
is unconfirmed. An unconfirmed teammate's Devices verify Revisions. They cannot sign a grant this
client accepts. The user confirms the identity after comparing fingerprints, with
`dotrelay team trust`, **Confirm fingerprint** in Members, or by answering the CLI share-keys
question, which names the fingerprint. Confirming keeps the version of the roster the user saw, so
a later missing or older roster is still a rollback.

Requiring a confirmation before any teammate's history verifies would break every persistent CI
runner when a teammate joins. It would also add little: a Revision that decodes needs the Project
Epoch Key, and every way a key reaches a client is gated below.

### Key adoption

- Signer sets come from verified rosters, split by use. History signers are every roster-verified
  Device. Grant signers are active Devices of the own account and of confirmed teammates. Account
  Key Envelopes and Wrappers are sealed under the AMK or a User-held secret, so the seal, not the
  signature, authenticates them, and they still accept the keys the service reports for the
  account's own Devices.
- The account's own Account Key Envelope wins over a grant.
- Each installation pins, per Project, the highest epoch it accepted and a one-way commitment to
  the Project Epoch Key of each epoch it holds (SHA-384 over a domain label, the Server Profile,
  Project, epoch and key). A different key for a pinned epoch, an epoch below the mark, or a
  self-minted key for a pinned epoch is refused. The pins live with the account trust pins, in
  the CLI state directory or the browser's wrapped IndexedDB store. They never leave the client.

### Handing a new Device the account key

- **Approval.** `device approve` adds the enrolled Device to the roster with the keys from the
  request file the user carried, when the approving Device holds the AMK.
- **Sending a transfer.** The sender seals only to a Device its verified roster lists, with the
  rostered X25519 key. For a Device not yet listed, the user compares the key fingerprint the
  service reports with the one the target shows (`dotrelay device list`, or Recovery in the
  browser), and the sender adds the target to the roster before sealing.
- **The transfer code.** The person carries `<transfer id>.<account fingerprint>` to the receiving
  Device instead of a bare id. The code comes from the sender's own transfer object, never from a
  server response.
- **Receiving a transfer.** A transfer is sealed to a public key, so its signature is the only
  evidence of the sender. The receiver opens it, derives the account identity from the key inside,
  and accepts it only when a roster signed by that identity lists the sender and the receiver
  itself, the identity matches any own pin, and the fingerprint matches the code. Because the
  sender adds its target before sealing, a withheld or older roster is refused. A key the service
  chose comes with an identity whose fingerprint does not match the code. Under `--no-input` a
  bare transfer id is refused; interactively the CLI shows the fingerprint and asks.
- The Device fingerprint is the first 20 bytes of SHA-384 over a domain label, the X25519 key and
  the Ed25519 key, shown like the account fingerprint.

### Sync and lanes

- `verifySyncPage` refuses a Revision whose epoch is lower than its parent's or the trusted
  starting point's. A publication carries the verified head's epoch and refuses to seal under an
  older one. Clients also refuse a page whose reported epoch is below the session's key epoch or
  below its own verified history.
- A Revision may carry only its own Revision object, the one Manifest descriptor its Manifest hash
  names, and committed lanes, each lane once. The decoder reads the descriptor by that hash.
- Every Value lane and commitment must name the Revision's author: as owner for a User-defined
  Value, as provider for a Shared Value. The decoder never opens another User's User-defined Value
  lane with this User's key.
- Lane format 2. A lane's field 50 now names its AES-GCM associated data. Format 1 binds the
  Variable, Revision and scope, as before. Format 2 binds the canonical CBOR of the lane's Server
  Profile, Team, Project, Environment, Variable, Revision, owner or provider, epoch, scope and
  format fields. New lanes use format 2. Format 1 lanes stay readable, and the owner checks above
  already stop a format-1 ciphertext from being read in another context. The v3 corpus pins both
  layouts as known answers.

## Considered options

- **A roster version and hash inside the transfer and approval objects.** That would have added
  fields to kinds 5 and 22. Having the approver add its target to the roster gives the receiving
  Device the same anchor (a roster at least as new as the handoff) with no wire change, and keeps
  the roster the one place that lists Devices.
- **A separate fingerprint prompt on the receiving Device.** Carrying the fingerprint in the code
  turns the comparison into a check the client makes, and costs the person nothing extra: they
  already copy the code.
- **Fixing User-defined Value context only in the decoder.** The owner and author checks alone stop
  the cross-context read. Lane format 2 also binds Shared Values and definitions to their
  Environment and costs one protocol field value.

## Consequences

- A User has to run a client that holds the AMK before teammates trust any of their Devices. Their
  first roster lists only that Device, so a Device that never held the AMK, including one revoked
  earlier, is not listed and its history does not verify. An account that needs such a Device
  listed approves it again from a Device with the AMK, or sends it the key with a confirmed
  fingerprint.
- `dotrelay team share-keys` and **Share project keys** need the Member to have a roster.
- `device recover --transfer --no-input` needs the full transfer code, and
  `device transfer --no-input` refuses a target the roster does not list.
- The pin file format stays version 1 with an optional `projects` map and an optional `confirmed`
  flag per teammate. An older client that rewrites the file drops both, which loses protection but
  never trust. Teammates pinned before this change start unconfirmed, so a grant from one of them
  waits until the user confirms their fingerprint.
- A roster published before this change may list every Device the service reported at the time.
  Nothing removes those entries; a Device that should not be there is revoked like any other, which
  marks it revoked in the next roster version.
- A client from before this change opens every lane with the format-1 associated data, so it
  reports a Value that an updated client wrote as unreadable. Update the web app and the CLI
  together. An API from before this change already stores format-2 lanes; one with this change also
  refuses an unknown format.
- Residual risks are unchanged: a Recovery Code restore trusts the roster the service serves at
  that moment, Membership windows come from the service, and a new Member must trust what the
  service says about the Team until they confirm fingerprints.
