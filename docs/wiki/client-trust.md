# Client trust and secure local Device storage

DotRelay's shared client runtime lives in `@dotrelay/client`. Web and CLI applications
consume its public exports for Server Profile pinning, v3 protocol verification, encrypted
Device storage, trusted-head continuity, reconciliation, and value-blind diagnostics.

## Trust state

Client trust progresses through explicit phases:

1. **Profile untrusted** — capabilities have not been pinned with `establishServerProfileTrust`.
2. **Runtime unverified** — WebCrypto runtime probes have not succeeded.
3. **Device unprovisioned** — no encrypted Device bundle exists locally.
4. **Device active** — a Device bundle is stored and trusted-head continuity holds.
5. **Continuity broken** — the service returned a head that does not extend the local chain.
6. **History trust reset required** — the User must explicitly acknowledge a **History Trust Reset**
   before adopting a replacement head after restore or equivocation.

Authentication establishes only the server-local User. Decryption and publication still require an
active Device and the signed protocol checks implemented in this package.

## Local storage guarantees and limits

### Browser

- Device private bundles are encrypted with a **non-exportable, origin-bound AES-GCM wrapping key**
  scoped to one Server Profile origin and id.
- Wrapped ciphertext and IVs may persist in application storage; private keys and bearer credentials
  never appear in plaintext config, tracked files, logs, or diagnostic events.
- Storage reads fail closed when the requested origin or Server Profile id does not match the
  wrapping scope.

### CLI

- The encrypted Device bundle record and the wrapping secret are stored separately.
- Wrapping secrets belong in the **operating-system credential store** through the
  `CredentialStore` adapter; unit tests use an in-memory adapter only.
- CLI adapters must not write private material or bearer tokens to tracked files.

JavaScript cannot guarantee zeroization. Temporary byte arrays are cleared on a best-effort basis,
but garbage collection and WebCrypto copies remain outside application control.

## Origin and profile isolation

Every storage scope is keyed by canonical Server Profile origin, immutable profile id, and Device id.
Cross-origin or cross-profile reads are rejected before decryption is attempted.

## Verification order

Before trusting synchronized protocol bytes, clients should:

1. Pin the Server Profile with `establishServerProfileTrust`.
2. Verify the WebCrypto runtime with `assertCryptoRuntime`.
3. Load and unwrap the local Device bundle.
4. Verify signed protocol objects, parent Revision links, grant recipient bindings, Project epoch,
   and Manifest descriptor ceilings.
5. Advance or reconcile the trusted head; refuse implicit continuity loss.

Malformed objects, signature failures, and parent-link breaks fail closed with generic client errors
that do not reveal which cryptographic component failed.

## Compromise exclusions

A hostile same-origin browser script, compromised operating-system account, or malware with access
to the credential store can extract local secrets. DotRelay does not claim protection against those
attackers. The service and network remain untrusted for plaintext; this package keeps decrypted
Manifest content client-only under normal operation.

## Safe reveal behavior

Diagnostics use the fixed **Diagnostic Field Allowlist** only. Protected Values, Variable names,
Environment names, and bearer credentials never enter Application Diagnostic Events.

User-defined Value **absence** (required but not supplied) remains distinct from an **empty** Value.
Reveal to clipboard, logs, or diagnostics requires an explicit boundary check through
`isRevealPermitted` and `assertRevealBoundary`.

## Related docs

- [Authentication and Server Profile trust](./authentication.md)
- [Device trust, grants, recovery, and rotation](./trust.md)
- [v3 classical WebCrypto core](./crypto.md)
