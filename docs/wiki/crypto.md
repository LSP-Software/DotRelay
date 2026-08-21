# v3 classical WebCrypto core

DotRelay supports one secret-capable Cryptographic Suite:
`dotrelay-e2ee-v3-classical-webcrypto`. The core uses X25519 and Ed25519, HKDF-SHA-384,
AES-256-GCM with a 96-bit IV and 128-bit tag, and SHA-384 through the standard Web Crypto API.
It is classical cryptography only and has no post-quantum resistance, fallback provider,
negotiation, migration, downgrade, or reduced-security path.

Ciphertexts are canonical CBOR maps using the existing v3 field registry. They carry the suite,
fresh 32-byte HKDF salt, ephemeral X25519 SPKI public key, fresh IV, ciphertext, SHA-384
ciphertext digest, and byte lengths. Associated data is supplied by the caller and is authenticated
by AES-GCM; it is not treated as plaintext metadata. Protocol objects and signatures continue to
use `encodeProtocolObject` and `signatureInput` from `@dotrelay/contracts`.

Decryption returns only plaintext or one generic `InvalidCiphertextError`. Malformed envelopes,
unsupported suites, wrong keys, wrong associated data, and authentication failures are
indistinguishable to callers.

## Runtime matrix

| Runtime | Operating system | Evidence and support boundary |
| --- | --- | --- |
| Chromium installed by Playwright | Ubuntu Linux in CI | Browser/Bun parity tests; this is the only browser entry currently evidenced. |
| Bun `1.3.14` | Ubuntu Linux in CI | Unit, import/export, encryption, and signature coverage. |
| Bun `1.3.14` | macOS and Windows CI matrix | CLI runtime targets; run the crypto suite on each OS before claiming secret-capable parity there. |

Other browsers, browser versions, operating systems, and Bun versions require fresh compatibility
evidence before being added to the supported matrix.

The JavaScript API cannot promise zeroization. Temporary byte arrays are cleared on a best-effort
basis, but garbage collection, copies made by Web Crypto, and provider-held `CryptoKey` material are
outside application control. `CryptoKey` objects cannot be reliably erased, and exported SPKI or
PKCS#8 bytes may be copied. Consequently this work does not make a production secret-capable
readiness claim by itself; independent security review and release evidence remain required.
