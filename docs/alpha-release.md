# Alpha release operations

## Admission

Set `ALPHA_GITHUB_IDS` on the API to comma-separated stable numeric GitHub user ids before admitting
alpha users. Usernames and email addresses are not accepted. An unset variable disables the gate;
an explicitly empty value denies everyone. API container images default `ALPHA_ADMISSION_REQUIRED=true`
and start with an empty list that denies everyone. Configurations requiring admission
refuse startup if the variable is missing entirely. Public/self-hosted operators must explicitly set
`ALPHA_ADMISSION_REQUIRED=false` to opt out. Restart the API after changing the list. The gate checks
the GitHub identity behind every authenticated request, including sessions created before the gate
was enabled, browser Device approval, and CLI bearer sessions. Public health and capabilities probes
remain available, as does sign-out. Signing in to GitHub is not itself admission to DotRelay data.

## Invite and provision a Member

Invite the Member by GitHub login in the Members view. The invitee accepts and sets up a browser or
CLI Device. An unlocked owner/admin then chooses **Share project keys** on the pending Member's row.
The browser wraps the existing keys for every initialized active Project to every active Device of
that Member. Keys remain encrypted in transit and on the service. User-defined Value keys are never
included. A signed activation binds the target Membership, recipient set, and exact grant digests.

The service verifies current roles, Devices, Project epochs, signatures, and the complete grant set
and commits grants plus activation in one transaction. A missing grant or concurrent change leaves
the Membership pending and rolls back the attempt. Refresh before retrying an uncertain response.
An identical request can be replayed with its original Idempotency-Key. The recipient needs to
refresh or pull after activation. The current bounded operation supports up to 128 Project/Device
pairs and the configured administrative request size. The donor must already have each Project's
key; a missing key is an error, never a reason to create a replacement key.

The API offers `GET` and `POST /api/v1/teams/:teamId/memberships/:membershipId/provision` to prepare
and commit the operation. Both require an active authorized Device. An empty Project has no key to
disclose; this operation provisions initialized active Projects. Use **Share project keys** again
on an active Member after initializing a new Project or when that Member adds Devices. A refresh
preserves their original activation time and immutable activation record.

## Lost or compromised Device

On another authorized Device, open **Devices**, choose **Revoke device**, and confirm. The operation
revokes the selected Device and signs the User out of every browser and CLI session. Sessions are
not bound to individual Devices, so this prevents a stolen session registering a replacement.
Sign in again on trusted Devices and unlock with the existing recovery method. A new Device or a
recovery-code reset is not required on trusted installations. Previously downloaded secrets cannot
be erased remotely; replace affected external credentials after a compromise.

The equivalent API is `POST /api/v1/devices/:deviceId/revoke` with an active actor Device and a
UUID `Idempotency-Key`, plus a JSON body `{"signature": "<base64>"}`. The value is the base64
encoding of the actor Device's 64-byte Ed25519 signature over the UTF-8 bytes of the compact JSON
`{"action":"device.revoke","deviceId":<target>,"operationId":<key>}` — exactly those three
properties, in that order, with no whitespace; the `deviceId` is the target's id and
`operationId` is the `Idempotency-Key` of the same request. A different byte sequence or encoding
fails verification. The signature proves the caller holds the actor Device's key, not only a
copied session, so a stolen session cannot revoke Devices and sign the User out of every other
session. The actor can revoke only its own User's Devices. CLI `logout` still removes the local
session; use Device revocation to invalidate copied sessions. A revoked Device's key material and
signed history are retained for verification, while subsequent protected API access is refused.

Replaying the original `Idempotency-Key` returns the recorded result without signing the User out
again. Because revocation deletes the User's sessions, a replay needs a new session and the
original actor Device: the recorded actor Device must still be `ACTIVE`, and a different Device
cannot replay the operation — including after the actor revoked itself, so check the actor's
status in the Devices list after a self-revocation before relying on a replay. A new key against
an already revoked Device is refused.

## Recovery after losing every Device

New Recovery Code wrappers carry a Device-signed Ed25519 authorization public key in optional
field 97. Its private seed is derived from the high-entropy Recovery Code and wrapper salt with
a separate HKDF-SHA-384 purpose, independent of wrapper encryption. No code or AMK is sent to the
service. A signed-in User can fetch only their high-entropy Recovery Code wrapper without an active Device, unwrap
locally, and sign a replacement Device certificate's digest, profile, User and operation id.
The service checks the currently active recovery wrapper under the User row lock before allowing
the otherwise first-Device-only bootstrap. Ordinary enrollment is unchanged; losing a Device does
not automatically revoke it. Revoke lost Devices after recovery.

Use **Recovery → Recover browser** on a clean browser, or `dotrelay device recover` on a clean CLI
installation. Existing Recovery Codes issued before this change still unlock existing Devices,
but cannot authorize a replacement. Rotate them once using this release on an existing unlocked
Device before relying on disaster recovery. This compatibility limit fails closed; it never falls
back to session-only authorization of additional Devices.

A stale project key is recovered from the existing Account Key Envelope or shared by an owner or
admin. Repair never generates a replacement random key under an existing epoch.

## Upload limits

Protocol requests use one authenticated User bucket across paths, tokens and Devices, allowing 600
requests per minute. Staging quotas cover all pending unexpired uploads across that User's Devices,
defaulting to 256 objects and 16 MiB. Checks and inserts serialize on the User row, including
concurrent uploads. Byte-identical retries consume no extra quota. Upload request bodies are also
bounded before protocol parsing. Committed history is retained separately from pending staging.

## npm publishing

The repository's `NPM_TOKEN` secret must identify an npm publisher with write access to `dotrelay`
and permit non-interactive CI publishing. Replace an expired or unauthorized token in repository
settings; source changes cannot grant npm permissions. Never put the token in this repository.

Both workflows run `scripts/publish-cli.ts`, which validates the token with npm before publishing
and removes its temporary npm configuration afterward. Stable versions use `latest`; prereleases
use their first prerelease identifier (`alpha`, `beta`, `rc`, or `dev`). An alpha therefore does not
replace the stable channel. The `latest` identifier is reserved for stable releases: a tag such as
`v1.2.3-latest.1` is rejected at publication time instead of moving the stable npm selector. Before announcing, verify the GitHub publish job succeeds and test
`npx dotrelay@alpha --version` in a clean environment. This change does not publish a package or
create a production release tag.

## Dependency audit

The alpha changes also refresh the lockfile for the current dependency advisories, including
Better Auth, Next.js, Hono, the shadcn tooling chain, and the issue panel's HTML sanitizer. The
`fast-uri` override advances to the patched 3.1.9 release. `deepmerge` is temporarily pinned to
4.1.2 because the current 4.3.1 release is affected by GHSA-gcqx-w48m-w2h4 and has no patched 4.x
successor; Bun's audit resolver identifies 4.1.2 as the unaffected fallback. Keep that override
until a fixed release is available. Run the sanitizer/panel regressions and the dependency audit
before changing it.

## Alpha release channels

Prerelease tags publish versioned Docker images and `latest-alpha`, plus an npm prerelease tag and
a GitHub prerelease. They never move `latest-stable` and never run automatic production deployment.
Deploy the selected versioned alpha image deliberately to the alpha installation. Stable tags
retain the production deployment path. Release runs serialize across tags so mutable image aliases
cannot be advanced by overlapping workflows. Configure the admission list on the target service
before deploying; source changes do not modify hosting configuration.

Password and passkey wrappers require a validated active Device; session-only recovery never discloses them.

Before cutting a prerelease, configure the `security-review` environment/repository variables
`ALPHA_WEB_ORIGIN` and `ALPHA_API_ORIGIN` to the exact HTTPS origins of the alpha installation.
The web image is built for those origins and refuses missing/invalid values; stable builds keep
the production origins. The release concurrency queue retains up to 100 pending tags.

## Remaining deployment and security gates

See [the versioned operations runbook](wiki/operations.md) for GitHub App permissions,
production configuration, explicit backed-up migrations, encrypted PostgreSQL
backup/restore, readiness, exact toolchain pins and failure handling. API startup
no longer applies migrations. Configure the maintenance process before deploying.
Issues #32 and #36 remain open: independent review, complete artifact-bound security
evidence, signed release packaging, supported production self-host bundle and full
operator restore/recovery workflows are not established merely by passing CI.
Until those gates close, do not admit external alpha users with real secrets.
