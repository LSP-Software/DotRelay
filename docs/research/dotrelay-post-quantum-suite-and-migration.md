# DotRelay post-quantum suite and migration

Research date: 2026-07-25

## Recommendation

Do not ship `dotrelay-e2ee-v1` for production secrets. DotRelay has not implemented or deployed the
MVP yet, so the safest migration is to supersede v1 before launch and make the first production
suite `dotrelay-e2ee-v2`. Retain v1 only as a documented, fail-closed protocol identifier and test
fixture; do not silently change what v1 means.

Freeze v2 around this closed suite:

| Purpose | `dotrelay-e2ee-v2` choice |
| --- | --- |
| Device and User recovery-wrapping encryption keys | Independent ML-KEM-768 and X25519 key pairs |
| Grants and public-key envelopes | A composite ML-KEM-768 + X25519 KEM following NIST SP 800-227 section 4.6, then HKDF-SHA-384 and XChaCha20-Poly1305-IETF |
| Device and User identity signatures | Independent ML-DSA-65 and Ed25519 signatures over the same canonical bytes; v2 verification requires both |
| Content encryption | Existing XChaCha20-Poly1305-IETF with 256-bit keys and random 192-bit nonces |
| Content-key derivation | HKDF-SHA-384 with the existing complete identifier and lane context |
| Commitments and revision chain | Existing SHA-384 commitments |
| Encoding | Existing closed deterministic-CBOR schemas, extended with a fixed suite and migration state |
| Recovery Kit | Existing random 256-bit recovery secret and AEAD envelope, updated to contain v2 keys and a v2 suite floor |

ML-KEM and ML-DSA are final NIST standards, not experimental algorithms. FIPS 203 defines
ML-KEM-768, and FIPS 204 defines ML-DSA-65
([FIPS 203](https://csrc.nist.gov/pubs/fips/203/final),
[FIPS 204](https://csrc.nist.gov/pubs/fips/204/final)). Both parameter sets target NIST security
category 3. ML-KEM-768 has a 1,184-byte public key, 2,400-byte expanded private key, 1,088-byte
ciphertext, and 32-byte shared secret. ML-DSA-65 has a 1,952-byte public key, 4,032-byte expanded
private key, and 3,309-byte signature
([FIPS 203](https://nvlpubs.nist.gov/nistpubs/fips/nist.fips.203.pdf),
[FIPS 204](https://nvlpubs.nist.gov/nistpubs/fips/nist.fips.204.pdf)). NIST permits implementations
to store and interchange the compact 64-byte ML-KEM seed and 32-byte ML-DSA seed instead of expanded
private keys, which is important for browser and CLI key bundles
([NIST PQC FAQ](https://csrc.nist.gov/Projects/Post-Quantum-Cryptography/faqs)).

The hybrid KEM should use NIST's finalized generic construction, not invent a combiner and not make
the current X-Wing draft normative. For each recipient, independently encapsulate with ML-KEM-768
and the existing X25519 KEM, then compute the composite secret exactly as:

```text
SHA3-384(
  mlkemShared || x25519Shared ||
  mlkemCiphertext || x25519Ciphertext ||
  mlkemPublicKey || x25519PublicKey ||
  fixedDotRelayV2DomainSeparator
)
```

The exact fixed-length ordering and domain separator are suite constants. Apply HKDF-SHA-384 to
derive the 256-bit grant-wrapping key and any distinct key-confirmation key. NIST SP 800-227
explicitly approves composite KEMs and SHA-3-family combiners that bind both shared secrets,
ciphertexts, encapsulation keys, parameters, and a domain separator; it also warns that merely
computing `KDF(K1, K2)` does not generically preserve chosen-ciphertext security and that composite
schemes add downgrade risk
([NIST SP 800-227 sections 4.3 and 4.6](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-227.pdf)).
Reject an all-zero X25519 result and fail closed on every malformed component.

ML-KEM does not authenticate the sender. Continue signing each complete grant, certificate,
enrollment, recovery, rollover, epoch-transition, and Revision object. For v2, generate independent
ML-DSA-65 and Ed25519 keys, attach both signatures over the same exact domain-separated canonical
bytes, and require both to verify. This retains today's classical assurance while making forgery
resistance depend on breaking both components. The final OpenPGP PQC standard uses the same
ML-DSA-65 + Ed25519 pairing and requires both component signatures to verify, although DotRelay must
use its own deterministic-CBOR envelope rather than OpenPGP packets
([RFC 9980 sections 2, 3.2, and 5.2](https://www.rfc-editor.org/rfc/rfc9980.html)).
Use the default hedged ML-DSA signing mode in production.

Do not choose ML-KEM- or ML-DSA-only operation for the first production suite. The standardized
post-quantum primitives are suitable for use, but retaining X25519 and Ed25519 limits the effect of
an early implementation defect or cryptanalytic break in the new lattice algorithms. Conversely,
do not treat the classical components as permission to accept a missing or invalid post-quantum
component. A future suite may become post-quantum-only after ecosystem maturity and an explicit
decision; it must not be negotiated by dropping components from v2.

## Effects on every v1 use

- **Device encryption and sealed-box grants:** replace each Device's single X25519 wrapping identity
  with independent ML-KEM-768 and X25519 keys. Replace sealed boxes with the fixed composite KEM
  plus AEAD construction above. The issuing Device signs the complete envelope with both signature
  keys.
- **User and Device identity:** extend both trust identities with ML-DSA-65 while retaining Ed25519.
  Certificates and rollovers bind all four public keys, their algorithms, the suite, and key
  generations. No component key may be reused outside its one DotRelay role.
- **Revision signatures:** every new v2 Revision carries both signatures. This adds 3,373 bytes per
  Revision (3,309 ML-DSA + 64 Ed25519), excluding small CBOR fields. Ten thousand Revisions therefore
  add about 32 MiB of signature material; clients and servers must stream and bound verification.
- **Recovery Kit envelope:** the random 256-bit recovery secret and symmetric AEAD remain
  post-quantum appropriate. Re-encrypt the current User trust seeds, suite floor, and recovery
  generation into a v2-domain-separated envelope. Recovery grants targeting a public recovery key
  use the same composite ML-KEM-768 + X25519 construction as Device grants.
- **Project and User Value key distribution:** random 256-bit Project Epoch Keys and User Value Keys
  remain suitable. Reissue every individually signed recipient grant using the v2 composite KEM.
  HKDF-SHA-384 replaces the v1 HKDF-SHA-256 labels without changing authorization boundaries.
- **Enrollment and recovery transcripts:** retain the existing dual-control flows, but bind both
  new public keys, the exact suite, the locally remembered minimum suite, and the predecessor
  identity/Device generation. Both signatures are mandatory on approvals, recovery proof, and
  identity rollover.
- **Revision commitments:** keep SHA-384. Grover-style quantum search does not make a 384-bit digest
  the weak link relative to the chosen suite. A cryptographic suite change still creates a new
  signed Revision rather than changing a historical commitment.
- **Immutable history:** v2 ciphertext can continue to reuse unchanged immutable lane objects only
  within v2 and the same permitted key context. A suite transition creates fresh v2 ciphertext for
  the current state; it never relabels v1 ciphertext as v2.
- **Hosted and self-hosted interoperability:** use the same suite identifier, constants, schemas,
  limits, and vectors. A deployment may not select weaker components, omit a component, or raise
  protocol ceilings. Capability discovery is informational, not algorithm negotiation.

## Harvest-now-decrypt-later and immutable v1 history

X25519 and Ed25519 are vulnerable to a cryptographically relevant quantum computer. SHA-384 and the
256-bit symmetric keys do not repair that: an adversary who records a v1 X25519 grant can later
recover its Project/User key and decrypt the retained content. NIST's transition draft emphasizes
that migrations take years and must start before the confidentiality lifetime plus migration time
reaches the expected quantum-computer horizon
([NIST IR 8547, initial public draft](https://csrc.nist.gov/pubs/ir/8547/ipd)).

No later rewrapping can retroactively protect a v1 grant already copied by the service, a backup, or
an observer. Deleting old grants reduces future collection but does not undo prior collection.
Likewise, append-only history means old v1 ciphertext remains available. A migration may append
fresh v2 encryption of historical plaintext to preserve v2-protected rollback, but it cannot make
the retained v1 bytes post-quantum confidential. Product claims must say exactly:

- data created at a v2 genesis is protected by v2;
- a migrated Environment's new state and future Revisions are protected after its v2 transition;
- retained v1 history is not retroactively post-quantum protected.

Because DotRelay has no production v1 data, avoiding this permanent exception is a strong reason to
supersede v1 before launch.

## Downgrade-resistant migration

Suites are closed protocol versions, not menus of algorithms. A client never offers "ML-KEM or
X25519" and never accepts whichever component the service selects. Capability exchange may say
whether a Device can process all of v2, but the signed Team/Project state selects exactly one suite.

Freeze the following phased state machine:

1. **Prepare.** A v2-capable client creates new independent ML-KEM-768 and ML-DSA-65 keys while
   retaining its v1 keys. The current User identity or an existing Device dual-signs a key-continuity
   object. The service records capability but v1 remains quantum-vulnerable during this phase.
2. **Provision.** Every active recipient Device receives v2 certificates and grants. A User with a
   Recovery Kit writes and verifies a v2 recovery envelope using the existing 256-bit secret with a
   new suite-specific derivation context. A Device that cannot upgrade must be revoked before
   cutover, not silently left a v1 grant.
3. **Transition atomically.** A new closed `SuiteTransition` object binds the Server Profile, Team,
   Project, previous suite, previous head id/hash, v2 suite, complete active recipient set, new
   Project epoch, replacement grants, recovery generation requirements, and freshly encrypted
   current Team-readable state. It carries valid v1 and v2 signatures and commits with the new head
   or not at all.
4. **Pin.** Clients persist the highest accepted suite floor for each Server Profile/User/Team/
   Project and include it in subsequent signed objects. Once a client observes v2, it refuses v1
   heads, grants, enrollment, recovery envelopes, and secret mutations. A recovered or newly
   enrolled Device obtains the floor through the v2 Recovery Kit or an approving Device, not from
   an unauthenticated server preference.
5. **Refuse.** The honest service rejects all v1 secret mutations and grants immediately after the
   atomic transition. Old clients already fail closed on the unknown v2 suite under the existing
   compatibility decision: they may transport opaque supported routing data, but cannot decrypt,
   merge, roll back, or write v2.

The accepted threat model still permits a malicious service to withhold the transition or show a
fresh client a fork. A locally pinned floor detects downgrade after that client has observed v2,
but without an external transparency witness DotRelay cannot promise global fork consistency.

For this undeployed MVP, set the refusal point earlier: production servers and current web/CLI
clients must reject `dotrelay-e2ee-v1` from their first release. If test deployments exist, permit
v1 only in an explicitly non-production migration tool, never in normal hosted or self-hosted
secret workflows.

## Runtime and implementation readiness

The **algorithms and the NIST composite construction are production standards/guidance**. The
cross-runtime implementation path is not yet production-ready:

- Chrome 151 beta exposes ML-KEM, ML-DSA, X-Wing, and ChaCha20-Poly1305 only through a new origin
  trial, not as a broadly interoperable browser baseline
  ([Chrome 151 beta](https://developer.chrome.com/blog/chrome-151-beta)).
- Mozilla's ML-KEM WebCrypto work remains an open enhancement
  ([Mozilla bug 1943614](https://bugzilla.mozilla.org/show_bug.cgi?id=1943614)).
- Bun 1.3.14 is the current release
  ([Bun releases](https://github.com/oven-sh/bun/releases)). A reproducible local probe on that
  release returned `NotSupportedError` for WebCrypto `generateKey` with `ML-KEM-768` and
  `ML-DSA-65`, while X25519 and Ed25519 succeeded.
- Node 24.7 added native ML-KEM and ML-DSA, demonstrating viable server-runtime APIs but not Bun or
  browser portability
  ([Node 24.7 release](https://nodejs.org/en/blog/release/v24.7.0)).
- `@noble/post-quantum` runs on major JavaScript runtimes and implements the needed algorithms, but
  its own project states that it has not been independently audited and has no side-channel
  protection. It is suitable for vectors and prototypes, not the production trust boundary without
  independent review
  ([noble-post-quantum README](https://github.com/paulmillr/noble-post-quantum#security)).
- Open Quantum Safe likewise explicitly says `liboqs` is for prototyping and does not recommend it
  to protect sensitive production data
  ([liboqs README](https://github.com/open-quantum-safe/liboqs#status)).

Therefore keep the existing single `@dotrelay/crypto` boundary, but do not select a production
package in this research ticket. A separately reviewed implementation decision must select one
audited, side-channel-conscious implementation usable from both browser and Bun (likely through a
shared WebAssembly boundary until native WebCrypto is interoperable), pin its exact build, and
measure it on supported devices. The primitive sizes make network/storage overhead predictable;
the available JavaScript project's self-reported Apple M4 measurements show the algorithms are
computationally plausible, but those figures are not an independent performance basis
([noble benchmarks](https://github.com/paulmillr/noble-post-quantum#speed)).

## Deterministic and negative vectors

Check in a new immutable `test-vectors/e2ee/v2/` corpus. Use NIST ACVP vectors for ML-KEM key
generation/encapsulation/decapsulation and ML-DSA key generation/sign/verify, plus RFC 7748,
RFC 8032, RFC 5869, SHA-3, and existing CBOR vectors. NIST's ACVP schema supplies deterministic
ML-KEM seeds and cases, and NIST exposes a demo service for generated validation vectors
([ACVP ML-KEM specification](https://pages.nist.gov/ACVP/draft-celi-acvp-ml-kem.html),
[NIST CAVP](https://csrc.nist.gov/projects/cryptographic-algorithm-validation-program)).
FIPS 203 restricts deterministic internal functions to testing; production randomness stays inside
the cryptographic module
([FIPS 203](https://nvlpubs.nist.gov/nistpubs/fips/nist.fips.203.pdf)).

Add DotRelay vectors for every trust object and Revision, the exact composite-KEM intermediate
values and final wrap key, both signatures, recovery, transition, and cross-runtime round trips.
Negative vectors must independently corrupt or remove each KEM component, key, ciphertext,
signature, suite, ordering, domain separator, recipient, epoch/generation, previous head, suite
floor, and transition field. Include all-zero X25519, malformed ML-KEM keys/ciphertexts, invalid
ML-DSA encodings, duplicate/non-canonical CBOR, stale floors, v1-after-cutover, partial transitions,
and old-client behavior. Verify the corpus with two independent implementations before freezing v2.

## Decisions superseded or extended

- **Research cryptographic building blocks for DotRelay end-to-end encryption** is superseded for
  public-key encryption, signatures, and HKDF. Its XChaCha20-Poly1305, deterministic-CBOR,
  independent-key, signed-grant, and cross-runtime-vector choices remain.
- **Design the end-to-end encryption and device lifecycle** must be extended with two encryption and
  two signing keys per User/Device, composite grants, dual signatures, a suite floor, key-continuity
  objects, recovery-envelope migration, and `SuiteTransition`.
- **Design the encrypted manifest, revision, conflict, and rollback protocol** must be extended with
  dual Revision signatures, v2-only lane reuse, the atomic suite-transition Revision, migration
  ceilings, and explicit v1 historical-confidentiality status. Its SHA-384 commitments and
  fail-closed version seam remain.
- **Define the security threat model and metadata budget** remains authoritative, but the visible
  public-key/signature/algorithm fields and ciphertext sizes grow. Its no-global-equivocation claim
  and inability to retract previously copied material remain essential to honest migration claims.

## Follow-on Wayfinder tickets

1. **Freeze the `dotrelay-e2ee-v2` suite and downgrade-resistant transition protocol.** Decide the
   exact composite-X25519 KEM definition, CBOR field registry, signature inputs, suite-floor scope,
   `SuiteTransition` validation/atomicity, recovery continuity, historical-read policy, refusal
   constants, size ceilings, and complete positive/negative vectors. This ticket should explicitly
   supersede or amend the four decisions listed above and obtain independent protocol review.
2. **Select and validate the browser/Bun post-quantum crypto provider.** Compare candidate
   native/Wasm implementations for FIPS conformance, independent audit status, constant-time
   behavior, supply chain, deterministic seed import, supported platforms, bundle size, memory,
   latency, and interoperability. The decision must include an independent implementation of the
   frozen vectors and a replacement plan for browser-native WebCrypto.
3. **Set the production post-quantum claim and v1 refusal policy.** Confirm that no production v1
   data exists, define test-deployment disposal/migration, document the precise HNDL and historical
   limits, and make production web, CLI, hosted, and self-hosted releases refuse v1 consistently.

Do not begin implementation until these decisions freeze the protocol and provider. NIST's final
crypto-agility guidance defines agility as replacing algorithms while preserving security and
operations; DotRelay's suite boundary, signed transition, monotonic floor, and common hosted/
self-hosted rules are the required mechanism, not runtime algorithm negotiation
([NIST CSWP 39 update 1](https://csrc.nist.gov/pubs/cswp/39/upd1/considerations-for-achieving-crypto-agility/final)).
