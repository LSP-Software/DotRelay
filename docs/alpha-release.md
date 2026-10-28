# Alpha release operations

## Admission

Set `ALPHA_GITHUB_IDS` on the API to comma-separated stable numeric GitHub user ids before admitting
alpha users. Usernames and email addresses are not accepted. An unset variable disables the gate;
an explicitly empty value denies everyone. Restart the API after changing the list. The gate checks
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

The equivalent API is `POST /api/v1/devices/:deviceId/revoke` with an active actor Device, a UUID
`Idempotency-Key`, and a JSON body carrying the actor Device's Ed25519 signature over
`{"action":"device.revoke","deviceId":<target>,"operationId":<key>}`. The signature proves the
caller holds the actor Device's key, not only a copied session, so a stolen session cannot revoke
Devices and sign the User out of every other session. The actor can revoke only its own User's
Devices. CLI `logout` still removes the local session; use Device revocation to invalidate copied
sessions. A revoked Device's key material and signed history are retained for verification, while
subsequent protected API access is refused. Replaying the original `Idempotency-Key` returns the
recorded result without signing the User out again; a new key against an already revoked Device is
refused.

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
