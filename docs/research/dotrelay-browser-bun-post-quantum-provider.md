# DotRelay browser and Bun post-quantum provider

Research date: 2026-07-25

## Recommendation

Select a **single, minimal portable-C WebAssembly provider built from the Linux Foundation Post-
Quantum Cryptography Alliance's `mlkem-native` and `mldsa-native`** for ML-KEM-768 and ML-DSA-65.
Keep that provider behind the existing `@dotrelay/crypto` boundary and use the exact same Wasm
artifact in supported browsers and Bun. Do not use runtime-native post-quantum APIs in the first
release, do not use architecture-specific assembly in the Wasm build, and do not accept a JavaScript
fallback.

The candidate source baseline reviewed here is:

- `mlkem-native` commit
  [`2cf613b6857ccec80b372814a0f387c8facbfea6`](https://github.com/pq-code-package/mlkem-native/tree/2cf613b6857ccec80b372814a0f387c8facbfea6),
  after its stable
  [`v1.2.0`](https://github.com/pq-code-package/mlkem-native/releases/tag/v1.2.0) release; and
- `mldsa-native` commit
  [`6e65c6e8a4d54d453bd78399d16fe42527ff9e87`](https://github.com/pq-code-package/mldsa-native/tree/6e65c6e8a4d54d453bd78399d16fe42527ff9e87),
  whose latest release is still
  [`v1.0.0-beta2`](https://github.com/pq-code-package/mldsa-native/releases/tag/v1.0.0-beta2).

This is a provider selection, not production approval. No currently published browser/Bun package
satisfies all of DotRelay's production gates. In particular, the selected C sources have strong
conformance, memory-safety, and timing evidence, but the exact minimal Wasm build and its JavaScript
adapter do not yet exist as a reviewed DotRelay artifact; `mldsa-native` has not reached a stable
release; and no independent security audit was found for either the complete selected source pair
or a Wasm wrapper. Those are mandatory implementation and release gates below, not facts this
research pretends to have validated.

Do not adopt the ready-made `mlkem-wasm`/`mldsa-wasm` packages even though they use the same upstream
C implementations. Their own READMEs call them beta software and “use at your own risk,” and their
committed generated Wasm and wrapper have no cited independent audit
([ML-KEM wrapper](https://github.com/dchest/mlkem-wasm),
[ML-DSA wrapper](https://github.com/dchest/mldsa-wasm)). They are useful API and size references,
not the production trust boundary.

## Why this provider fits the frozen suite

The frozen `dotrelay-e2ee-v2` suite persists a 64-byte ML-KEM private seed and a 32-byte ML-DSA
private seed, requires identical public-key derivation in browser and Bun, and requires hedged
ML-DSA signing in production.

`mlkem-native` exposes `keypair_derand` with exactly `2 * MLKEM_SYMBYTES`, where
`MLKEM_SYMBYTES` is 32 bytes, and exposes deterministic encapsulation with a separate 32-byte input.
Its public header identifies those calls with FIPS 203 Algorithms 16 and 17
([pinned API](https://github.com/pq-code-package/mlkem-native/blob/2cf613b6857ccec80b372814a0f387c8facbfea6/mlkem/mlkem_native.h)).
This directly supplies deterministic expansion of DotRelay's canonical 64-byte seed into the
1,184-byte public key and 2,400-byte expanded private key.

`mldsa-native` exposes `keypair_internal` from a `MLDSA_SEEDBYTES` seed and
`signature_internal` with a caller-provided 32-byte `rnd`; its public API documents the normal
signing call as the randomized FIPS 204 variant and the all-zero `rnd` internal call as the
deterministic test-only variant
([pinned API](https://github.com/pq-code-package/mldsa-native/blob/6e65c6e8a4d54d453bd78399d16fe42527ff9e87/mldsa/mldsa_native.h),
[hedged-signing guidance](https://github.com/pq-code-package/mldsa-native/blob/6e65c6e8a4d54d453bd78399d16fe42527ff9e87/README.md#does-mldsa-native-use-hedged-or-deterministic-signing)).
The DotRelay adapter must therefore obtain 32 fresh bytes from `crypto.getRandomValues` for every
production signature and reserve all-zero randomness for immutable vector generation only.

Both projects implement the finalized standards, test all three parameter sets against official
NIST ACVP and Wycheproof vectors, and permit compile-time selection of only ML-KEM-768 or ML-DSA-65
([ML-KEM evidence](https://github.com/pq-code-package/mlkem-native/blob/2cf613b6857ccec80b372814a0f387c8facbfea6/README.md#test-vectors),
[ML-DSA evidence](https://github.com/pq-code-package/mldsa-native/blob/6e65c6e8a4d54d453bd78399d16fe42527ff9e87/README.md#test-vectors)).
An independent Symbolic Software conformance battery reported that `mlkem-native` passed all 21
tests exposed through its public API with no failures; it did not report a harness result for
`mldsa-native`, so that evidence must not be generalized to ML-DSA
([Crucible results](https://symbolic.software/blog/2026-03-23-crucible/)).

## Assurance and side-channel posture

`mlkem-native` states that all selected portable C and FIPS-202 C code is proved free of memory and
integer overflow with CBMC. Its assembly backends have stronger HOL-Light functional and
secret-independent-timing proofs, but those native backends are deliberately excluded from the
portable Wasm build. The portable C uses compiler barriers and constant-time patterns and is
dynamically checked with Valgrind across compiler configurations
([ML-KEM verification and security](https://github.com/pq-code-package/mlkem-native/blob/2cf613b6857ccec80b372814a0f387c8facbfea6/README.md#formal-verification)).

`mldsa-native` likewise says CBMC covers all C involved in the portable backend and uses barriers,
constant-time patterns, and Valgrind checks. Its native assembly proof does not yet prove
secret-independent timing for the rejection samplers, although the project states they are
constant-time; that assembly caveat does not directly apply to the selected portable-C Wasm build,
but it is evidence that the assurance story is not complete
([ML-DSA verification and security](https://github.com/pq-code-package/mldsa-native/blob/6e65c6e8a4d54d453bd78399d16fe42527ff9e87/README.md#formal-verification)).
Both projects explicitly put power, electromagnetic, speculative-execution, and fault-injection
attacks outside their current timing-focused scope
([ML-KEM scope](https://github.com/pq-code-package/mlkem-native/blob/2cf613b6857ccec80b372814a0f387c8facbfea6/README.md#security),
[ML-DSA scope](https://github.com/pq-code-package/mldsa-native/blob/6e65c6e8a4d54d453bd78399d16fe42527ff9e87/README.md#security)).

WebAssembly does not turn the C evidence into a proof about emitted machine code. The chosen
Emscripten/LLVM version, optimizer, Wasm engine, adapter copies, bounds checks, and zeroization all
sit outside the upstream proofs. Production approval therefore requires an independent review of
the exact compiled artifact on every supported engine, including generated-code timing tests for
key generation, decapsulation, and signing. The existing DotRelay threat model still rules a
compromised same-origin client out of scope; the provider must not imply that Wasm protects keys
from hostile same-origin JavaScript.

## Runtime and platform matrix

There is no interoperable native baseline today. Chrome 151 exposes ML-KEM and ML-DSA only through
an origin trial, Mozilla's ML-KEM WebCrypto enhancement remains open, and the proposal is a 2026
WICG incubator specification rather than the established Web Cryptography Recommendation
([Chrome 151 beta](https://developer.chrome.com/blog/chrome-151-beta),
[Mozilla enhancement](https://bugzilla.mozilla.org/show_bug.cgi?id=1943614),
[modern-algorithms incubator](https://wicg.github.io/webcrypto-modern-algos/)).
Bun 1.3.14 is the current stable release and supports Linux x64/arm64, macOS x64/Apple Silicon, and
Windows x64/arm64, but it does not expose ML-KEM-768 or ML-DSA-65 through WebCrypto
([Bun release and platform list](https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14)).
A local Bun 1.3.14 probe on 2026-07-25 confirmed that
`crypto.subtle.generateKey({ name: "ML-KEM-768" }, ...)` and the equivalent ML-DSA-65 call each
throw `NotSupportedError`, while X25519, Ed25519, SHA-384, and SHA3-384 succeed. This is reproducible
runtime evidence, not a substitute for the full release matrix.

Portable C90 with no native backend is a realistic Wasm source, but neither selected repository
claims a browser or Bun support matrix. Consequently the following matrix is a release gate, not
current validation:

| Surface | Required production validation |
| --- | --- |
| Chromium | Current and previous stable Chrome and Edge on Windows x64, macOS arm64, and Linux x64 |
| Firefox | Current and ESR on Windows x64, macOS arm64, and Linux x64 |
| WebKit | Current and previous Safari on supported macOS, plus current iOS/iPadOS arm64 |
| CLI | The pinned Bun release on every DotRelay-distributed Bun target: Linux x64/arm64, macOS x64/arm64, and Windows x64/arm64 |

Every cell must run NIST vectors, the complete frozen DotRelay corpus, malformed-input tests,
browser-to-Bun and Bun-to-browser round trips, concurrency tests, and repeated initialize/destroy
cycles. A platform with a functional or timing failure is unsupported; it does not receive a
JavaScript or single-algorithm fallback.

## Size, memory, and latency

The upstream headers provide useful static bounds. ML-KEM-768's maximum custom allocation is 15,552
bytes with pairwise-consistency testing, 13,248 bytes for encapsulation, and 14,336 bytes for
decapsulation
([ML-KEM allocation constants](https://github.com/pq-code-package/mlkem-native/blob/2cf613b6857ccec80b372814a0f387c8facbfea6/mlkem/mlkem_native.h#L461-L523)).
For ML-DSA-65 the normal allocation bounds are 74,624 bytes for key generation with
pairwise-consistency testing, 69,312 bytes for signing, and 39,872 bytes for verification; its
reduced-RAM build lowers those figures while trading performance
([ML-DSA allocation constants](https://github.com/pq-code-package/mldsa-native/blob/6e65c6e8a4d54d453bd78399d16fe42527ff9e87/mldsa/mldsa_native.h#L814-L898)).
These are algorithm allocation bounds, not total Wasm linear memory or JavaScript heap use.

The upstream projects publish native benchmark infrastructure and commands for speed, stack, and
binary-size measurement, but no evidence found here validates the combined DotRelay Wasm artifact's
compressed transfer size, initialization time, peak memory, or latency in browser and Bun
([ML-KEM benchmarking](https://github.com/pq-code-package/mlkem-native/blob/2cf613b6857ccec80b372814a0f387c8facbfea6/README.md#benchmarking),
[ML-DSA benchmarking](https://github.com/pq-code-package/mldsa-native/blob/6e65c6e8a4d54d453bd78399d16fe42527ff9e87/README.md#benchmarking)).
The implementation gate must record raw and Brotli/gzip size, Wasm initialization, peak linear and
JavaScript memory, and p50/p95/p99 keygen/encap/decap/sign/verify latency for every matrix cell and a
low-tier supported device. Verification of long Revision chains must also be streamed and bounded;
the provider may not allocate proportionally to the 64 MiB protocol ceiling or the number of
historical signatures.

## Supply chain and reproducible build

The selected projects are small vendorable C source trees with minimal configurable dependencies
and permissive Apache-2.0/ISC/MIT licensing. `mlkem-native` is used by AWS-LC and liboqs;
`mldsa-native` reports use by AWS-LC and liboqs
([ML-KEM applications](https://github.com/pq-code-package/mlkem-native/blob/2cf613b6857ccec80b372814a0f387c8facbfea6/README.md#applications),
[ML-DSA applications](https://github.com/pq-code-package/mldsa-native/blob/6e65c6e8a4d54d453bd78399d16fe42527ff9e87/README.md#applications)).
That is useful deployment evidence, not an audit of DotRelay's build.

The reviewed head commits are not GitHub-verified signatures, and the GitHub releases publish source
tags rather than signed Wasm assets. The upstream README also says its supplied build system is for
development, leaving the integrating application responsible for its production build
([ML-KEM usage](https://github.com/pq-code-package/mlkem-native/blob/2cf613b6857ccec80b372814a0f387c8facbfea6/README.md#usage),
[ML-DSA usage](https://github.com/pq-code-package/mldsa-native/blob/6e65c6e8a4d54d453bd78399d16fe42527ff9e87/README.md#usage)).

The production build must therefore vendor only the reviewed ML-KEM-768, ML-DSA-65, and shared
portable FIPS-202 sources; pin upstream commits and the Emscripten/LLVM container by digest; disable
all other parameter sets, randomized wrapper APIs, native assembly, filesystem, network, clocks,
and dynamic growth; export only the closed DotRelay operations; generate an SBOM; and publish the
source manifest, compiler flags, Wasm hash, and provenance attestation. Two isolated builders must
produce byte-identical Wasm before release. Upstream changes require a new review, full corpus,
timing, matrix, and reproducibility run rather than a floating dependency update.

## Supplying the rest of `dotrelay-e2ee-v2`

The selected Wasm module owns only ML-KEM-768, ML-DSA-65, and the SHA3-384 combiner operation backed
by the same vendored FIPS-202 code. It must not grow into a second protocol layer.

The remaining frozen primitives stay behind `@dotrelay/crypto`:

- a separately source- and release-pinned `libsodium-wrappers` provider supplies X25519, Ed25519, and
  XChaCha20-Poly1305-IETF; libsodium documents those APIs and its WebAssembly JavaScript build
  ([public-key signatures](https://doc.libsodium.org/public-key_cryptography/public-key_signatures),
  [X25519 scalar multiplication](https://doc.libsodium.org/advanced/scalar_multiplication),
  [XChaCha20-Poly1305](https://doc.libsodium.org/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction),
  [JavaScript/Wasm build](https://github.com/jedisct1/libsodium.js));
- WebCrypto supplies SHA-384, HKDF-SHA-384, cryptographically secure randomness, and the existing
  non-exportable origin-bound browser wrapping key; SHA-384 and HKDF are established WebCrypto
  algorithms
  ([Web Cryptography Recommendation](https://www.w3.org/TR/WebCryptoAPI/)); and
- deterministic CBOR remains a codec responsibility, not provider-native serialization.

The boundary accepts and returns only frozen raw fixed-length bytes. ASN.1, JWK, provider objects,
expanded private-key persistence, and algorithm negotiation never cross it.

## Key storage and memory lifecycle

Browser Devices continue encrypting the canonical four-seed private bundle with their non-exportable
origin-bound WebCrypto wrapping key. CLI Devices continue placing the encrypted bundle and wrapping
secret in the OS credential store. The Wasm provider receives a compact seed only for an operation,
derives the expanded key in private linear-memory regions, returns only the required public output,
signature, ciphertext, or shared secret, and zeroizes seeds, expanded keys, signing randomness, and
shared secrets before returning.

That lifecycle is compatible with the frozen bundle but is not yet validated. The independent
integration review must inspect every JS-to-Wasm copy, allocator reuse, exception path, memory-growth
path, worker transfer, and teardown; tests must demonstrate zeroization after success and every
failure. JavaScript garbage collection cannot provide a hard wiping guarantee, so adapters must use
fixed caller-owned typed arrays, minimize copies, overwrite them eagerly, and never serialize secret
material to strings, JWK, logs, crash reports, analytics, or browser storage.

## Independent interoperability

The provider must first pass the exact official ACVP sets used by the upstream projects. It must
then derive the frozen public keys from DotRelay's 64-byte ML-KEM and 32-byte ML-DSA seeds, produce
deterministic test-only signatures and encapsulations, and match the immutable
`test-vectors/e2ee/v2/` corpus byte for byte in browser and Bun.

The independent oracle must not share PQ Code Package code. Use OpenSSL 3.5 or later's default
provider for ML-KEM-768 and ML-DSA-65: OpenSSL documents deterministic ML-DSA 32-byte seed import and
public-key regeneration, raw ML-KEM/ML-DSA keys, and conformance to FIPS 203/204
([ML-DSA key management](https://docs.openssl.org/3.5/man7/EVP_PKEY-ML-DSA/),
[ML-KEM key management](https://docs.openssl.org/3.5/man7/EVP_PKEY-ML-KEM/),
[raw-key API](https://docs.openssl.org/3.5/man3/EVP_PKEY_new/)).
Pair that oracle with native libsodium and independent SHA-384/HKDF/CBOR implementations to verify
the complete composite-KEM intermediates, signatures, AEAD associated data, and final frozen
objects. `oqs-provider` is not the oracle because OpenSSL 3.5 implements the standardized algorithms
natively and provider selection can otherwise be ambiguous
([oqs-provider guidance](https://github.com/open-quantum-safe/oqs-provider)).

No provider is production-approved until the independent oracle verifies every positive and
negative frozen vector and a separate cryptographic/application-security reviewer signs off on the
exact Wasm source manifest, adapter, build, error behavior, timing evidence, key lifecycle, and
matrix results.

## Candidate disposition

| Candidate | Disposition |
| --- | --- |
| PQ Code Package portable C compiled once to Wasm | **Selected, subject to the explicit audit/build/runtime gates.** It has exact seed and hedged-signing APIs, final FIPS behavior, small vendorable surfaces, CBMC safety evidence, and timing-oriented design. |
| `mlkem-wasm` + `mldsa-wasm` | Reject as the production artifact. Technically close and useful as a reference, but both wrappers declare beta status and lack independent wrapper/build audit and trusted reproducible provenance ([ML-KEM](https://github.com/dchest/mlkem-wasm), [ML-DSA](https://github.com/dchest/mldsa-wasm)). |
| `@noble/post-quantum` | Reject for production; retain only as an optional vector oracle. Its project explicitly says it has not been independently audited and has no side-channel protection, despite convenient deterministic seeds and a small JavaScript surface ([security statement](https://github.com/paulmillr/noble-post-quantum#security)). |
| `liboqs` / `@oqs/liboqs-js` | Reject. liboqs says it is for prototyping and does not recommend protecting sensitive production data; the JS wrapper says it has no formal audit and requires manual object destruction ([liboqs status](https://github.com/open-quantum-safe/liboqs#status), [JS security](https://github.com/open-quantum-safe/liboqs-js#security-considerations)). |
| PQClean / `node-pqclean` | Reject. PQClean's own project is preparing for archival, and independent Crucible testing found FIPS 203 modulus-check gaps in its ML-KEM public API ([PQClean status](https://github.com/PQClean/PQClean), [Crucible finding](https://symbolic.software/blog/2026-03-23-crucible/)). |
| libcrux Wasm | Reject for this release. Its security policy still calls the project pre-release with no supported versions, and a 2025 advisory affected ML-KEM and ML-DSA output on AArch64 through an unverified intrinsic fallback ([security policy](https://github.com/celabshq/libcrux/blob/main/SECURITY.md), [advisory](https://github.com/advisories/GHSA-2cgv-28vr-rv6j)). |
| OpenSSL, BoringSSL, AWS-LC, Botan, CIRCL, wolfCrypt | Do not select as the cross-runtime provider. They are credible native implementations or independent oracles, but none publishes one supported browser-and-Bun artifact with DotRelay's raw-seed and hedged-signing contract. BoringSSL also explicitly makes no API/ABI stability guarantees ([BoringSSL README](https://boringssl.googlesource.com/boringssl/+/refs/heads/main/README.md)). |
| Native WebCrypto | Defer. Current exposure is experimental and not interoperable across the supported browser/Bun matrix ([WICG proposal](https://wicg.github.io/webcrypto-modern-algos/), [Chrome origin trial](https://developer.chrome.com/blog/chrome-151-beta)). |

## Native WebCrypto replacement and fallback

`@dotrelay/crypto` must expose capability-neutral DotRelay operations, not a `wasm` or `subtle`
object. The Wasm provider remains the mandatory fallback for as long as any supported browser or Bun
lacks a conforming native implementation.

A native provider may replace an operation only after:

1. the relevant WebCrypto algorithms are standardized rather than origin-trial-only and ship
   unflagged in every supported browser engine and pinned Bun;
2. native import of DotRelay's canonical 64-byte ML-KEM and 32-byte ML-DSA seeds derives the exact
   existing public keys, and native ML-DSA supports FIPS 204 hedged signing;
3. every supported runtime passes the complete frozen corpus, independent oracle, malformed-input,
   error-uniformity, key-storage, and performance matrix; and
4. a reviewed staged release runs native and Wasm providers against the same non-secret vectors and
   records no divergence.

Native support that can generate keys but cannot import the canonical seeds is not a transparent
replacement. It may be considered only with a future explicit identity-rollover design; it must not
silently create a split provider or change `dotrelay-e2ee-v2`. A native mismatch or runtime
regression disables that native provider and falls back to the already-reviewed Wasm implementation,
never to JavaScript crypto and never to a reduced suite.

## Production approval gates

The selection is complete, but production approval remains blocked until implementation work
delivers all of the following:

- a stable `mldsa-native` release or an explicit independent-review acceptance of the pinned
  pre-release commit;
- a minimal source manifest and byte-reproducible Wasm build with SBOM and provenance;
- an independently audited adapter with only the frozen raw-byte operations;
- generated-code constant-time and malformed-input testing on every runtime matrix cell;
- exact 64-byte/32-byte seed derivation and fresh-randomness hedged signing tests;
- complete ACVP, frozen DotRelay, negative, and browser/Bun round-trip vectors verified by the
  independent OpenSSL-based oracle;
- measured compressed size, initialization, peak memory, latency, concurrency, and long-history
  verification with documented release budgets;
- verified secret zeroization and compatibility with browser wrapping and CLI credential storage;
  and
- separate independent protocol/provider-integration approval required by the frozen suite.

Failure of any gate returns the provider decision to Wayfinder. It does not authorize noble,
liboqs-js, a beta wrapper, native-only operation, or production launch with a weaker suite.
