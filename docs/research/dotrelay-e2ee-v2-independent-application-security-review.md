# DotRelay `dotrelay-e2ee-v2` independent application-security review packet

**Review date:** 2026-07-25  
**Review scope:** frozen `dotrelay-e2ee-v2` provider gate  
**Disposition:** **BLOCKED — evidence dossier only; no approval issued**  
**Repository revision inspected:** `fae68a9a827f9c9c8aa569094513a0c5357a3f92` (`codex/implement-issue-30`)  

This packet records what is evidenced, what is only required by the authoritative decisions, and
what is absent. It does not implement cryptography, integrate a provider, or constitute protocol,
application-security, or release approval.

## 1. Authority and review basis

The authoritative inputs are:

| Authority | Effect on this packet |
| --- | --- |
| [`CONTEXT.md`](../../CONTEXT.md) | DotRelay vocabulary and security-boundary terminology. |
| [`AGENTS.md`](../../AGENTS.md) | Repository rules, including Bun package management and code-style constraints. |
| [Wayfinder map #1](https://github.com/LSP-Software/DotRelay/issues/1) | `dotrelay-e2ee-v2` is the only first-release suite; no earlier suite, migration, suite floor, or transition object is implementation scope. |
| [Completed decision #17](https://github.com/LSP-Software/DotRelay/issues/17) | Frozen v2 wire suite, encodings, derivations, ceilings, generic rejection behavior, and provider-neutral contract requirements. |
| [Completed decision #18](https://github.com/LSP-Software/DotRelay/issues/18) | Source-pinned portable-C Wasm provider selection and the provider production gates. |
| [Completed decision #19](https://github.com/LSP-Software/DotRelay/issues/19) | Conditional security claim, exclusions, evidence requirements, compatibility errors, and hard no-waiver release gate. |
| [Open integration issue #26](https://github.com/LSP-Software/DotRelay/issues/26) | Concrete provider implementation acceptance criteria: exact artifact, source/build evidence, complete vectors/oracle/matrix, lifecycle, and performance gates. |
| [Open contract/vector issue #30](https://github.com/LSP-Software/DotRelay/issues/30) | Contract and vector acceptance criteria, including provider primitive cases and independent protocol approval; the issue remains open. |
| [Open final gate #36](https://github.com/LSP-Software/DotRelay/issues/36) | Requires this version-bound dossier and separate independent cryptographic/application-security review before any secret-capable release. |
| [`docs/research/dotrelay-browser-bun-post-quantum-provider.md`](dotrelay-browser-bun-post-quantum-provider.md) | Primary-source-backed provider research and explicit statement that selection is not production approval. |
| [`test-vectors/e2ee/v2/README.md`](../../test-vectors/e2ee/v2/README.md) and [`packages/contracts`](../../packages/contracts/src/registry.ts) | Checked-in immutable deterministic-CBOR contract corpus and registry. |

The issue tracker was queried read-only on the review date. No issue or comment supplies a Wasm
artifact hash, completed build record, or completed independent review report.

## 2. Provider identity and artifact identity

### 2.1 Selected source baseline

Decision #18 selects one minimal portable-C WebAssembly provider built from the PQ Code Package
sources, with only ML-KEM-768, ML-DSA-65, and the SHA3-384 combiner operation exposed. The exact
reviewed source revisions are:

| Component | Exact revision | Release context | Evidence status |
| --- | --- | --- | --- |
| `mlkem-native` | `2cf613b6857ccec80b372814a0f387c8facbfea6` | After stable `v1.2.0` | **Recorded source baseline; not vendored or built in this repository.** |
| `mldsa-native` | `6e65c6e8a4d54d453bd78399d16fe42527ff9e87` | Latest cited release is `v1.0.0-beta2` | **Recorded pre-release source baseline; stable-release gate remains open.** |

The revisions are recorded in [decision #18](https://github.com/LSP-Software/DotRelay/issues/18) and
the [provider research, lines 14–31](dotrelay-browser-bun-post-quantum-provider.md#L14-L31). The
research identifies deterministic 64-byte ML-KEM seed input, deterministic test-only ML-DSA seed
input, and fresh 32-byte signing randomness as required adapter behavior
([provider research, lines 42–60](dotrelay-browser-bun-post-quantum-provider.md#L42-L60)).

### 2.2 Wasm artifact hash

**No DotRelay provider Wasm artifact exists in the inspected repository, so no exact Wasm artifact
hash can be reported.** The repository contains no tracked provider source, Wasm build directory,
Wasm adapter, source manifest, artifact manifest, SBOM, provenance attestation, or provider-specific
release asset. The unrelated Wasm files under `node_modules/` are dependency internals and are not
the selected provider artifact.

Required final record, currently unfilled:

```text
Provider artifact:                 <exact release asset name>
SHA-256:                           <64 lowercase hex characters>
SHA-512:                           <128 lowercase hex characters>
Wasm module size:                  <bytes>
Uncompressed source archive hash:  <digest>
Adapter revision:                  <commit or immutable source digest>
Repository/tag:                    <exact DotRelay release tag>
```

An artifact hash cannot be inferred from the two upstream source commits. A byte-identical Wasm
build must be produced and independently re-hashed before review or approval.

## 3. Reproducible toolchain and independent rebuild requirements

### 3.1 Requirements from the authoritative decisions

The production build must:

1. vendor only the reviewed ML-KEM-768, ML-DSA-65, and shared portable FIPS-202 source files;
2. pin both upstream commits and the Emscripten/LLVM toolchain, including the container/image
   digest and every other build input;
3. disable other parameter sets, native assembly, filesystem, network, clocks, dynamic memory
   growth, randomized wrapper APIs, and unneeded exports;
4. export only the closed DotRelay raw-byte operations;
5. record compiler version, target, flags, linker flags, export list, source file manifest, and
   generated files;
6. build the same artifact for every supported browser and Bun target; and
7. obtain byte-identical Wasm from two isolated builders, with independently retained logs and
   digests.

These requirements are explicit in [decision #18](https://github.com/LSP-Software/DotRelay/issues/18),
the [provider research, lines 154–175](dotrelay-browser-bun-post-quantum-provider.md#L154-L175),
and [decision #19's supply-chain gate](https://github.com/LSP-Software/DotRelay/issues/19).

### 3.2 Repository evidence

The repository pins Bun `1.3.14` in [`package.json`](../../package.json#L1-L5), and CI sets the same
version and pins its checkout/setup actions by commit in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml#L15-L29).
The release workflow reruns the repository verification gate and builds the current CLI on
`ubuntu-latest` ([`.github/workflows/release.yml`](../../.github/workflows/release.yml#L14-L33)).

There is no Emscripten/LLVM toolchain declaration, container digest, Wasm linker configuration,
provider build script, two-builder job, or reproducibility comparison. The current repository
toolchain therefore does not establish a reproducible provider build.

### 3.3 Independent rebuild acceptance record

The reviewer should not accept a build until this record is complete:

| Field | Builder A | Builder B | Required comparison |
| --- | --- | --- | --- |
| Host/image identity and digest | `<fill>` | `<fill>` | Different isolated environments. |
| Source manifest digest | `<fill>` | `<fill>` | Exact match. |
| Toolchain/image digest | `<fill>` | `<fill>` | Pinned and independently recorded. |
| Compiler/linker flags | `<fill>` | `<fill>` | Exact match. |
| Exported symbols | `<fill>` | `<fill>` | Exact closed operation set. |
| Raw Wasm SHA-256 | `<fill>` | `<fill>` | **Byte-identical.** |
| Rebuild log hash | `<fill>` | `<fill>` | Retained for audit. |
| Reviewer conclusion | `<fill>` | `<fill>` | Pass / fail / finding ID. |

## 4. SBOM, provenance, and supply-chain evidence

### Evidence present

- The candidate commits and release context are recorded above.
- The provider research records that the upstream projects are small vendorable C trees and notes
  their reported licensing and downstream use ([lines 154–167](dotrelay-browser-bun-post-quantum-provider.md#L154-L167)).
- The repository has a frozen `bun.lock` and digest-pinned CI action/container references, but those
  describe the existing monorepo gate, not the missing provider build.

### Evidence missing and required

- SPDX or CycloneDX SBOM for the exact provider source, adapter, Wasm artifact, toolchain, and build
  image, including transitive build dependencies.
- Minimal source manifest with path, byte length, and digest for every vendored file; upstream
  archive/tag/signature verification; and license/notice inventory.
- SLSA/in-toto or equivalent provenance tied to the exact artifact digest and build invocation.
- Builder identity, isolation controls, immutable source checkout, dependency lock, network policy,
  environment capture, and reproducibility logs.
- Artifact signature/attestation and release summary binding the Wasm hash to the exact web, CLI,
  hosted, and self-hosted release artifacts.
- Evidence that no architecture-specific assembly, JavaScript crypto fallback, native post-quantum
  path, extra algorithm, or negotiation surface is present.

The upstream source's conformance or downstream use is not provenance for DotRelay's compiled
artifact. The research explicitly says the upstream release tags are not signed Wasm assets and the
integrator owns the production build ([lines 163–175](dotrelay-browser-bun-post-quantum-provider.md#L163-L175)).

## 5. Frozen v2 vectors, ACVP/RFC results, and independent oracle

### 5.1 What is present: provider-neutral v2 contract corpus

The checked-in corpus is immutable and intentionally provider-neutral. Its README says it covers
the deterministic-CBOR and wire boundary, while provider ACVP/RFC vectors belong to the later
provider ticket ([vector README, lines 1–18](../../test-vectors/e2ee/v2/README.md#L1-L18)). The inventory
on this checkout is:

| Corpus | Count | SHA-256 |
| --- | ---: | --- |
| `primitives.json` CBOR fixtures | 11 | `8ffc0f6ebd65f1ed2f97138f9829f1f31bf8ed99f2d815bbbc94a3401eddf917` |
| `primitives.json` domain separators | 3 | same file hash above |
| `objects.json` object vectors | 19 | `df6a81a7cad785720161ecde1466984d948a8c78b15ff59817d5b17576a02c87` |
| `conditional.json` conditional vectors | 28 | `0f6fee7080b9e6534669fda1e3f9a0ab2d5baa106aae506d05f3e139a08dde94` |
| `negative.json` malformed cases | 21 | `f73e01700d0e186766a6815e376dfd428c21d30700b443f994a84548ae2beae1` |
| `browser-bun.json` round-trip fixtures | 4 | `91c1097f37faa00aba68b71f553cd4eea125f523d52fac6f80e32c71f5967ab8` |
| `positive.json` object manifest | 19 objects / 6 enum groups | `9a277840d21028268aff4f9c116c3a95cd6058c1b67c90cf6ad35ca992f9e8a9` |

The corpus covers object kinds 1–19, mutation values 1–5, lane scopes 1–4, key kinds 1–3, grant
kinds 1–7, membership roles 1–3, lifecycle values 1–6, canonical round trips, explicit ceilings,
and coarse malformed-object errors. The registry fixes the required raw lengths, including ML-KEM
`1184/1088`, ML-DSA `1952/3309`, four-key identity `3200`, digest `48`, nonce `24`, and opaque ID
`16` bytes ([registry, lines 21–113 and 366–382](../../packages/contracts/src/registry.ts#L21-L113)).

### 5.2 Executed repository result

On 2026-07-25, Bun `1.3.14` ran:

```text
bun test scripts/contracts-vectors.test.ts
6 pass, 0 fail, 348 expect() calls

bun run check
9 pass, 0 fail, 351 expect() calls; format, lint, typecheck, boundaries, OpenAPI, and package unit tests passed
```

The vector test asserts all 19 object kinds, all 28 conditional vectors, the frozen negative corpus,
browser/Bun byte fixture symmetry, ceilings, and coarse errors ([test, lines 49–302](../../scripts/contracts-vectors.test.ts#L49-L302)).
This is useful evidence for the codec boundary only; it is not provider conformance or an
application-security approval.

### 5.3 Missing provider vector and oracle results

No provider-specific ACVP files, RFC 7748/X25519 results, RFC 8032/Ed25519 results, RFC 5869/HKDF
results, SHA-3/SHA-384 results, XChaCha20-Poly1305 results, composite-KEM intermediates, signature
inputs, or final provider-backed objects are checked in. No independent oracle harness or result
report exists.

The required independent oracle is OpenSSL 3.5-or-later's default provider for ML-KEM-768 and
ML-DSA-65, paired with independent libsodium, SHA-384/HKDF, and deterministic-CBOR implementations;
it must not share PQ Code Package code ([provider research, lines 215–237](dotrelay-browser-bun-post-quantum-provider.md#L215-L237)).
The required result is every positive and negative provider vector verified byte-for-byte, not a
statement that the upstream projects ran their own tests. This gate is **missing**.

## 6. Browser, Bun, OS, and architecture matrix

### Required release matrix

Decision #18 requires all of the following matrix cells, with every cell executing NIST vectors,
the complete frozen corpus, malformed-input tests, browser↔Bun round trips, concurrency tests, and
repeated initialize/destroy cycles ([provider research, lines 99–129](dotrelay-browser-bun-post-quantum-provider.md#L99-L129)):

| Surface | Required targets |
| --- | --- |
| Chromium | Current and previous stable Chrome and Edge on Windows x64, macOS arm64, and Linux x64 |
| Firefox | Current and ESR on Windows x64, macOS arm64, and Linux x64 |
| WebKit | Current and previous Safari on supported macOS; current iOS/iPadOS arm64 |
| Bun CLI | Pinned Bun on Linux x64/arm64, macOS x64/arm64, and Windows x64/arm64 |

### Evidence actually present

- The monorepo declares Bun `1.3.14`; the local verification host was Darwin arm64.
- CI has a browser E2E job that installs Chromium on `ubuntu-latest` only
  ([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml#L89-L100)).
- CI has a packaged CLI matrix across Ubuntu, macOS, and Windows, but does not declare an explicit
  architecture matrix and does not run the missing provider
  ([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml#L102-L116)).
- The provider research records that Bun's native ML-KEM/ML-DSA WebCrypto calls returned
  `NotSupportedError` in a local Bun 1.3.14 probe; therefore the selected Wasm provider is mandatory
  rather than optional ([lines 107–113](dotrelay-browser-bun-post-quantum-provider.md#L107-L113)).

There are no provider test results for any matrix cell. Firefox, Edge, Safari, iOS/iPadOS, arm64
Windows/Linux, and cross-runtime provider round trips are un evidenced. A passing current CI job
cannot be promoted to a full matrix result.

## 7. Malformed-input, timing, concurrency, zeroization, and performance evidence

| Area | Evidence present | Gate status |
| --- | --- | --- |
| Contract malformed input | 21 frozen malformed CBOR/object cases; all passed with `invalid_crypto_object` except unsupported suite. Canonical decoding rejects noncanonical integers, indefinite lengths, duplicate/unknown fields, tags, floats, invalid UTF-8, truncation, bad lengths, and invalid conditional fields ([CBOR decoder](../../packages/contracts/src/cbor.ts#L183-L274), [negative corpus](../../test-vectors/e2ee/v2/negative.json#L1-L110)). | **Partial:** codec only. |
| Provider malformed input | No ML-KEM key/ciphertext, ML-DSA encoding, signature, all-zero X25519, truncated provider buffer, or adapter error corpus. | **Missing; blocks.** |
| Timing / generated code | Upstream portable-C CBMC, compiler-barrier, constant-time-pattern, and Valgrind claims are documented, with power/EM/speculative/fault attacks outside upstream scope ([research, lines 71–97](dotrelay-browser-bun-post-quantum-provider.md#L71-L97)). | **Missing:** no exact Wasm generated-code timing evidence. |
| Concurrency | No provider implementation or concurrent initialize/operation/destroy test. | **Missing; blocks.** |
| Zeroization | The design requires wiping seeds, expanded keys, signing randomness, and shared secrets on success and every failure path, and inspecting copies, allocator reuse, exceptions, growth, worker transfer, and teardown ([research, lines 199–213](dotrelay-browser-bun-post-quantum-provider.md#L199-L213)). | **Missing; blocks.** |
| Performance / memory | Upstream static allocation bounds are recorded, but no combined Wasm size, compression, initialization, peak Wasm/JS memory, p50/p95/p99 latency, low-tier device, or long-history measurements exist ([research, lines 131–152](dotrelay-browser-bun-post-quantum-provider.md#L131-L152)). | **Missing; blocks.** |
| Stable error behavior | Current contract has `invalid_crypto_object` and `unsupported_crypto_suite` ([errors](../../packages/contracts/src/errors.ts#L1-L55)); decision #19 additionally requires `unsupported_crypto_runtime` and `crypto_provider_unavailable` before secret processing. | **Missing implementation/evidence; blocks.** |

The existing contract rejects server-visible private seed fields and validates fixed lengths, but no
provider lifecycle exists to prove that the seeds remain encrypted at rest, are expanded only inside
the provider, and are not copied to strings, logs, crash reports, analytics, or browser storage.

## 8. Security claim and exclusions required by decision #19

The following is the only permitted production claim, and only after every evidence gate passes:

> DotRelay provides hybrid post-quantum end-to-end encryption for protected Environment and Variable content using `dotrelay-e2ee-v2`. When uncompromised supported clients run the reviewed release artifacts, confidentiality against the service and network attackers remains protected while at least one of ML-KEM-768 or X25519 remains secure, and mutation authenticity remains protected while at least one of ML-DSA-65 or Ed25519 remains unforgeable, subject to the documented protocol, implementation, and operational assumptions.

This is a conditional hybrid claim, not “quantum-proof,” “future-proof,” unconditionally secure,
formally verified end to end, anonymous, always available, or safe on a compromised client. Both
components in both frozen pairs are always executed and required; no negotiation, omission, single-
algorithm fallback, or alternate provider is permitted ([decision #19](https://github.com/LSP-Software/DotRelay/issues/19)).

The claim must be accompanied by exclusions for:

- browser-origin, operating-system, authorized Device, or other authorized-client compromise;
- malicious active Members and legitimate recipients retaining, copying, or disclosing plaintext or keys;
- retroactive erasure of plaintext or keys obtained before revocation/removal;
- timing, network addresses, request frequency, opaque relationships, ciphertext/transfer sizes, and other allowed traffic metadata;
- service, operator, network, or infrastructure failure that delays, withholds, corrupts, or deletes ciphertext;
- guaranteed detection of a malicious service suppressing Revisions or presenting different internally valid histories without an external witness;
- implementation, integration, key-handling, compiler, runtime, and side-channel defects, including power, EM, speculative-execution, and fault-injection attacks outside reviewed timing evidence;
- recovery after all authorized Devices and the Recovery Kit are lost; and
- future cryptanalytic or standards changes that invalidate an algorithm or assurance assumption.

Hosted and self-hosted deployments must use the same protocol, provider artifact, verification,
compatibility errors, and gates. A self-hoster may lower operational quotas but may not weaken or
relabel the cryptographic claim.

## 9. Reviewer checklist

Mark each item **Pass**, **Fail**, **N/A with rationale**, or **Blocked — evidence missing**. Every
artifact digest in the checklist must match the release dossier's artifact identity.

### Scope and identity

- [ ] Review is against the exact tagged web, CLI, hosted, and self-hosted artifacts.
- [ ] `dotrelay-e2ee-v2` is the only suite; no suite floor, migration, transition, negotiation, or fallback was introduced.
- [ ] Provider source commits, adapter revision, source manifest, Wasm hash, and release tag are mutually bound.
- [ ] The protocol freeze has a separate independent approval record before implementation.

### Build and supply chain

- [ ] `mlkem-native` and `mldsa-native` source manifests are minimal, digest-pinned, and license-complete.
- [ ] `mldsa-native` stable release or explicit independent-review acceptance of the pinned beta source is recorded.
- [ ] Emscripten/LLVM and all build inputs are pinned by immutable digest.
- [ ] Portable C only; no architecture-specific assembly, filesystem, network, clocks, dynamic growth, extra algorithms, or unreviewed exports.
- [ ] Two isolated builders produce byte-identical Wasm; logs and hashes are retained.
- [ ] SBOM, provenance, signatures/attestations, and release summary bind to the same artifact hash.

### Adapter and provider boundary

- [ ] Only frozen raw fixed-length bytes cross the boundary; no ASN.1, PEM, JWK, provider objects, expanded-key persistence, or free-form labels.
- [ ] ML-KEM 64-byte seed derivation and ML-DSA 32-byte seed derivation match in browser and Bun.
- [ ] Production ML-DSA signing is hedged with fresh randomness; all-zero randomness is test-only.
- [ ] No native WebCrypto, JavaScript fallback, reduced hybrid pair, or alternate provider is used.
- [ ] Startup self-tests and stable errors are identical across web, CLI, hosted, and self-hosted packaging.

### Conformance and independent verification

- [ ] Exact upstream ACVP cases pass for ML-KEM keygen/encap/decap and ML-DSA keygen/sign/verify.
- [ ] RFC 7748, RFC 8032, RFC 5869, SHA-3/SHA-384, XChaCha20-Poly1305, and deterministic-CBOR results pass.
- [ ] Every immutable positive, conditional, negative, boundary, enrollment, recovery, grant, Revision, epoch, and Rollback vector passes.
- [ ] Composite-KEM intermediates, signature input, HKDF values, AEAD associated data, commitments, and final objects match byte-for-byte.
- [ ] Browser-to-Bun and Bun-to-browser provider round trips pass.
- [ ] OpenSSL 3.5-or-later plus independent classical/hash/CBOR oracle verifies every positive and negative result without shared PQ Code Package code.

### Runtime, safety, and operations

- [ ] Every required Chromium, Firefox, WebKit, iOS/iPadOS, Bun OS, and Bun architecture cell passes.
- [ ] Malformed provider keys/ciphertexts/signatures, all-zero X25519, truncation, length, and error-uniformity tests pass.
- [ ] Generated-code timing tests cover keygen, encapsulation, decapsulation, signing, and verification per matrix cell.
- [ ] Concurrency, repeated initialize/destroy, worker transfer, memory growth, exception, and teardown tests pass.
- [ ] Zeroization is observed after success and every failure path; JavaScript copies are eagerly overwritten.
- [ ] Raw/compressed size, initialization, peak Wasm/JS memory, p50/p95/p99 latency, low-tier-device, and bounded long-history budgets pass.
- [ ] Canonical compact seeds remain encrypted at rest and never enter logs, diagnostics, crash reports, analytics, or storage outside the approved bundle.

### Claim and release

- [ ] Claim and all #19 exclusions are adjacent in claim-bearing documentation.
- [ ] `unsupported_crypto_suite`, `unsupported_crypto_runtime`, `crypto_provider_unavailable`, and `invalid_crypto_object` behavior is verified before secret processing.
- [ ] Hosted and self-hosted packaging has identical protocol/provider artifacts and evidence.
- [ ] Every finding has a disposition; critical/high findings and unresolved cryptographic-boundary medium findings are closed.
- [ ] Dossier, audit report, artifact hash, and report hashes are attached to the tag-only release record.

## 10. Finding-disposition template

Copy one row per finding and attach the supporting report or test log by immutable hash.

| Field | Value |
| --- | --- |
| Finding ID | `ASR-<YYYYMMDD>-<NNN>` |
| Title | `<short description>` |
| Severity | `Critical / High / Medium / Low / Informational` |
| Affected artifact | `<release tag + Wasm SHA-256 + adapter revision>` |
| Affected scope | `source / build / adapter / protocol / runtime / storage / release / documentation` |
| Evidence | `<report, test, log, or trace link and SHA-256>` |
| Reproduction | `<exact command, matrix cell, input/vector ID, and observed result>` |
| Security impact | `<confidentiality / authenticity / availability / metadata / none>` |
| Disposition | `Fix / Mitigate / Accept / Reject / Duplicate / Not reproducible` |
| Rationale | `<why disposition is valid against #18/#19>` |
| Owner | `<named owner or external reviewer>` |
| Due date | `<date>` |
| Verification evidence | `<new artifact/test/report hash>` |
| Reviewer decision | `Open / Closed / Blocked` |

Release rule: Critical and High findings block release. An unresolved Medium finding in the
cryptographic boundary blocks release. A Low finding may remain only with documented ownership,
rationale, and remediation tracking. A disclaimer, beta label, reduced matrix, provider substitution,
weaker fallback, or waiver does not clear a hard gate.

## 11. Explicit external sign-off fields

These fields must be completed by named external reviewers or independently accountable approvers;
repository authorship or a passing local test is not a substitute.

### Protocol freeze review

```text
Reviewer name / organization:
Independence statement:
Scope: frozen dotrelay-e2ee-v2 specification and vector contract
Decision reviewed: #17
Protocol revision / dossier hash:
Findings report hash:
Disposition: APPROVE / RETURN TO WAYFINDER / BLOCK
Signature or verifiable approval URL:
Date:
```

### Cryptographic/provider implementation review

```text
Reviewer name / organization:
Independence statement:
Scope: exact source manifest, adapter, Wasm artifact, generated code, error behavior,
       timing, malformed inputs, storage, copies, allocator/exception paths, zeroization,
       vectors, oracle, and runtime matrix
Provider Wasm SHA-256:
Adapter revision:
Source manifest hash:
SBOM hash:
Provenance/attestation hash:
Findings report hash:
Critical/high findings closed: YES / NO
Crypto-boundary medium findings closed: YES / NO
Disposition: APPROVE / BLOCK
Signature or verifiable approval URL:
Date:
```

### Independent rebuild and oracle attestations

```text
Builder A identity / organization / environment digest:
Builder B identity / organization / environment digest:
Builder A Wasm SHA-256:
Builder B Wasm SHA-256:
Byte-identical: YES / NO
Rebuild log hashes:

Oracle operator / organization:
Oracle implementation versions and independent-code statement:
ACVP/RFC/vector result report hash:
All positive and negative cases pass: YES / NO
Signature or verifiable attestation URL:
Date:
```

### Release approver

```text
Approver name / organization:
Exact web artifact hash:
Exact CLI artifact hash(es):
Hosted/self-hosted package hashes:
Provider Wasm SHA-256:
Dossier hash:
Claim/exclusions documentation revision:
All #18/#19 gates pass without waiver: YES / NO
Decision: RELEASE / NON-PRODUCTION ONLY / BLOCK
Signature or verifiable approval URL:
Date:
```

## 12. Current approval blockers

The following are individually sufficient to block approval; together they establish that this
packet cannot authorize a provider or a production claim:

1. **No exact provider artifact or Wasm hash.** The two source commits are selected baselines only;
   no DotRelay Wasm or adapter is present.
2. **No stable `mldsa-native` release or independent acceptance of the beta source.**
3. **No minimal vendored source manifest, digest-pinned Emscripten/LLVM build, compiler flags,
   export list, two-builder comparison, or rebuild logs.**
4. **No SBOM, provenance, source/archive verification, artifact signature, or attestation.**
5. **No independent audit of the exact Wasm output, adapter, or provider integration.**
6. **No provider ACVP/RFC results.** The checked-in corpus is provider-neutral codec evidence only;
   open [issue #30](https://github.com/LSP-Software/DotRelay/issues/30) still lists the primitive and
   intermediate-value corpus as acceptance criteria.
7. **No independent OpenSSL-based oracle or complete positive/negative provider result report.**
8. **No complete runtime/OS/architecture matrix results.** Existing CI covers only a Chromium
   Ubuntu job and an OS-name CLI matrix, neither of which runs the provider.
9. **No provider malformed-input, generated-code timing, error-uniformity, concurrency, repeated
   lifecycle, or startup self-test evidence.**
10. **No zeroization or secret-copy evidence** for Wasm linear memory, JavaScript typed arrays,
    allocator reuse, exceptions, worker transfer, memory growth, or teardown.
11. **No combined Wasm performance evidence** for size/compression, initialization, peak memory,
    p50/p95/p99 latency, low-tier devices, or bounded long-Revision-chain verification.
12. **No provider-backed key-storage evidence** proving encrypted-at-rest compact seeds and
    provider-only expansion for browser and CLI Devices.
13. **Required #19 compatibility errors are not in the current contract registry.** The repository
    has `invalid_crypto_object` and `unsupported_crypto_suite`, but no provider/runtime-unavailable
    implementation or result record.
14. **Open implementation work remains.** Provider integration issue [#26](https://github.com/LSP-Software/DotRelay/issues/26)
    and contract/vector issue [#30](https://github.com/LSP-Software/DotRelay/issues/30) remain open;
    their acceptance criteria are not evidenced by the current tree.
15. **No completed independent protocol/provider-application-security sign-off** with finding
    dispositions. The current open [#36 final gate](https://github.com/LSP-Software/DotRelay/issues/36)
    explicitly requires it.
16. **No version-bound claim-bearing documentation and artifact/report hash summary** for web, CLI,
    hosted, and self-hosted packaging. The current release policy also notes that platform-specific
    artifacts and npm distribution are not yet published ([release policy, lines 7–14](../../docs/wiki/release-policy.md#L7-L14)).

Because the evidence is missing rather than merely undocumented, no external sign-off field in this
packet may be marked complete and no production claim may be issued.

## 13. Non-approval conclusion

The frozen contract boundary is locally healthy: the immutable deterministic-CBOR corpus and current
repository checks pass, and the selected source revisions are recorded. The provider gate is not
ready for independent approval. The next authorized work is evidence-producing implementation and
independent review under decisions #18 and #19; it is not a provider approval, crypto integration,
or production release.
