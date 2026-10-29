# Recovery Code authorization for a replacement Device

Status: accepted

ADR 0010's first-Device-only bootstrap and existing-Device approval made disaster recovery
impossible when all local Device keys were lost while a remote Device remained ACTIVE. Recovery
must prove possession of a User-held secret without giving the service the Recovery Code or AMK.

Recovery Code wrappers may carry field 97, a 32-byte Ed25519 public key. Its seed derives from the
256-bit Recovery Code and the wrapper salt using HKDF-SHA-384 and the purpose
`dotrelay-recovery-authorization-ed25519-v1`. The existing wrapper signature and encryption AAD
cover this field. Password and passkey wrappers cannot carry it. No additional database secret
or private key is stored.

The session may read only its own encrypted Recovery Code wrapper and its authenticated creator Device key
without an active Device. Clients verify and unwrap the wrapper before authorizing a replacement.
The proof signs the `dotrelay-device-recovery-v1` message binding the profile UUID, User UUID,
operation UUID and SHA-384 digest of the self-signed replacement certificate. Bootstrap checks
the current non-retired recovery wrapper under the same User lock used for wrapper rotation,
then performs the usual identity-generation and certificate checks atomically. Retired codes,
changed certificates, changed operations and cross-User/profile proofs cannot activate a Device.
An identical committed operation remains replayable without another activation.

Ordinary session-only bootstrap remains first-Device-only. Existing Device approval and Device
revocation retain their existing authorization requirements. Recovery leaves the old Device's
lifecycle unchanged; the User can revoke it after regaining access.

Wrappers without field 97 remain readable but cannot authorize replacement Devices. Existing
Users must rotate their Recovery Code with this release before relying on disaster recovery.
The optional field extends the pre-alpha v3 registry, so ship the API, web and CLI together.

Password and passkey wrappers require a validated active Device; session-only recovery never discloses them.
