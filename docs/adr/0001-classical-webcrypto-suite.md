# Use one classical WebCrypto suite for v3

Status: accepted

DotRelay v3 uses one closed Cryptographic Suite, `dotrelay-e2ee-v3-classical-webcrypto`, based on
X25519, Ed25519, HKDF-SHA-384, AES-256-GCM, and SHA-384 through the standard Web Crypto API. The
first release does not provide post-quantum resistance and does not include a v2 migration, suite
negotiation, fallback provider, or reduced-security mode. This keeps browser and Bun clients on one
testable wire contract while making the security claim explicit.
