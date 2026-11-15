# Authentication and Server Profile trust

DotRelay runs one Better Auth authority in the Hono API. The Next.js application is a browser
client of that authority, and the CLI uses the RFC 8628 device-authorization flow. GitHub is only
the upstream sign-in provider: a GitHub access token is never sent to or stored by the CLI.

Each hosted or self-hosted Server Profile supplies its own GitHub OAuth application. Register the
callback URL as:

```
https://<server-origin>/api/auth/callback/github
```

Configure `SERVER_PROFILE_ID`, `SERVER_PROFILE_ORIGIN`, `WEB_ORIGIN`, `BETTER_AUTH_SECRET`,
`GITHUB_CLIENT_ID`, and `GITHUB_CLIENT_SECRET` before starting a production API. Production origins
must use HTTPS, and `BETTER_AUTH_SECRET` must be a random value of at least 32 characters. If TLS
is terminated by a trusted reverse proxy, set `SERVER_PROFILE_TRUST_PROXY=true` and list its IP
addresses or CIDR ranges in `SERVER_PROFILE_TRUSTED_PROXIES`. The proxy must replace, rather than
append to, client-supplied forwarding headers and the API origin must not be directly reachable.
Without this setting, the API rejects forwarded HTTPS claims and requires its direct request URL to
be HTTPS.

The Server Profile id is an opaque, immutable UUID stored in PostgreSQL and returned with the
canonical origin by `/api/v1/capabilities`. Clients pin both values after explicit trust. A changed
id at the same origin is an identity failure; moving a profile requires an explicit rebind with the
same pinned id. Set `SERVER_PROFILE_REBIND=true` only for that deliberate startup rebind; normal
startup fails closed rather than silently changing the persisted profile identity. The API never
discovers a profile through an ambient redirect.

Client connection code must pass the fetched capabilities document and the response origin to
`establishServerProfileTrust` before it reads a bearer token, cookie, recovery material, or encrypted
Value. The helper validates the API and Cryptographic Suite, checks the runtime algorithms, and
returns the Server Profile pin to persist. It rejects a redirect, a changed id, or a moved origin.
Only an explicit rebind may update the origin, and the pinned id must remain unchanged. Unsupported
API and suite values produce `unsupported_api_version` and `unsupported_crypto_suite`;
`unsupported_crypto_runtime` means the client cannot use every v3 Web Crypto algorithm. These checks
do not inspect secret material or reveal which cryptographic component failed.

Browser sessions use secure HttpOnly same-site cookies and exact-origin credentialed CORS. State
changing cookie requests must come from the configured web or Server Profile origin. When the web
app and the API are served from different hosts, the browser must present the session cookie to
both origins so the web app's server-side session relay can forward it to the API. Set
`COOKIE_DOMAIN` to the registrable domain both hosts share (for example `dotrelay.dev` for
`dev.dotrelay.dev` and `dev-api.dotrelay.dev`); it must equal or be a parent of both hosts, and
startup fails otherwise. Without it, cookies are shared only when one host is the parent of the
other (web `example.com`, API `api.example.com`), and otherwise stay host-only. DotRelay has no
public-suffix list, so it never derives a domain from a common suffix: on a shared platform domain
(`*.example-platform.app`) that would send session cookies to other tenants. Never set
`COOKIE_DOMAIN` to such a domain. CLI sessions
use a Better Auth bearer token returned by device authorization and should be stored in the CLI's
local credential store (encrypted files in the CLI state directory). A request containing both a
bearer token and a cookie is rejected.

Authentication establishes only the server-local DotRelay User. It does not grant Membership,
Device authority, decryption ability, or mutation permission. Encrypted operations still require an
active Device and the application-level signed protocol checks.

## Device proof of possession

A session alone never acts as a Device ([ADR 0020](../adr/0020-device-proof-of-possession.md)).
Every Device-scoped request carries a Device proof in `X-DotRelay-Device-Proof`: a short-lived
token the Device gets by signing a service challenge with its Ed25519 key.

1. `POST /api/v1/devices/proofs/challenges` (session only) returns a challenge bound to the
   session. It is valid for 120 seconds.
2. The Device signs `dotrelay-device-proof-v1`, a NUL byte, the Server Profile, User and Device
   ids (16 bytes each) and the challenge bytes.
3. `POST /api/v1/devices/proofs` with `{ deviceId, challenge, signature }` returns
   `{ token, deviceId, expiresIn }`. The proof expires 300 seconds after its challenge was issued
   and works only with the session that asked for the challenge.

`X-DotRelay-Device-Id` is only the claimed Device; when present it must match the proven one. A
missing, expired or foreign proof is `401 device_proof_required`, and clients then get a new proof
and send the same request once more. A Device that is not active is `403 device_not_active`, on
the exchange and on every later request. Without a proof, `GET /api/v1/workspace/boundary`
returns the session view: no Device, Device ids, keys, rosters, key links, grants or Account Key
Envelopes. The CLI and the browser get a proof when they first need one and refresh it before it
expires. Session expiry, logout, and remote
revocation are database-backed and take effect on the next request. Sessions slide: each day of use
extends them to 30 days. Independently, any session, browser cookie or CLI bearer, ends 90 days
after it was created; the API deletes an older session before any route reads it, and the
retention job removes the rest.

The user-facing login journey continues after GitHub verification. The browser gates the workspace
until it has a durable Device key and can open the Account Master Key; returning browsers restore a
Device-sealed local copy. CLI login enrolls and unlocks the Device before reporting success. In
noninteractive CLI setup of an existing account, it exits with a specific locked-key error and the
`dotrelay device recover` command to finish the journey. An OAuth session may briefly exist during
these steps because it is required to fetch encrypted wrappers; it never grants decryption by itself.

Better Auth permits ten requests to one authentication route in a 60-second window. Device codes
expire after 10 minutes and the CLI must wait at least five seconds between token polls; an early
poll returns `slow_down`. With `VALKEY_URL` set, the limiter's counters live in Valkey and every
API replica shares them; if Valkey is unreachable it falls back to per-process memory. Development
without Valkey uses per-process memory. In production, requests without a trusted client address
share one conservative route bucket, so the trusted-proxy settings in
[operations](operations.md#configuration-and-startup) are required for per-client limits. The
API reads `X-Forwarded-For` only when trusted proxies are configured, and walks the chain past the
listed proxy addresses. A `429` response carries `X-Retry-After`. Auth and protocol CORS expose both
`X-Retry-After` and the protocol rate limiter's `Retry-After`, so the web app can show the wait.

The capabilities response is public and may be cached briefly with its ETag. Authenticated
responses are `no-store`. Errors use the stable `application/problem+json` contract and never
include stack traces, bearer credentials, OAuth tokens, plaintext, or cryptographic component
details.

## Security review record

The auth tables and opaque DotRelay User table have separate identifiers. A successful GitHub
callback creates or updates Better Auth records; `/api/v1/session` resolves the GitHub subject to a
server-local DotRelay User without granting a Membership or authorizing a Device. Better Auth
encrypts stored OAuth tokens. The CLI receives only its database-backed session token.

Each GitHub sign-in also records the profile's login for its GitHub user id in `github_logins`, so
the Team membership list can show it and `dotrelay team share-keys <login>` can find a Member
without a GitHub lookup. The login is display data: it can be stale after a rename and is never
used for authorization or key decisions. A failure to record it does not block the sign-in.

Cookie and bearer credentials are separate request modes. Browser state changes need an exact
configured Origin, and production cookies are Secure, HttpOnly, and SameSite=Lax. CLI bearer
requests do not need a browser Origin. The API rejects a request that combines either mode. Better
Auth's cookie cache is disabled, so logout, expiry, and remote session deletion take effect on the
next request instead of waiting for a signed-cookie cache to expire.

Only service-signed bearer tokens are accepted: the session token followed by its HMAC-SHA-256
under `BETTER_AUTH_SECRET`, the form the session cookie carries. The device token endpoint returns
the CLI's token in that form. `get-session` and `list-sessions` answer without session tokens, so
page script on the web origin never reads a token it could replay. CLI sessions created before
signed tokens must log in again.

Each User keeps the GitHub account that created them. Better Auth account linking is off, so a
GitHub sign-in whose verified email matches an existing User is refused rather than linked, and
`link-social` and `unlink-account` are blocked. The service also refuses a session whose GitHub
account differs from the User's recorded GitHub identity.

The integration tests cover the exact GitHub callback, OAuth state rejection, secure cookie
attributes, cross-subdomain cookie scoping, exact-origin CORS and CSRF failures, mixed credentials,
device polling and expiry, endpoint limiting, logout, remote revocation, session expiry,
capabilities ETags, profile rebinding, and suite or runtime refusal before credential access.

Signed-in Users may fetch their own encrypted Recovery Code wrapper without an active Device to
start disaster recovery. A replacement Device requires the Recovery Code proof described in
[ADR 0013](../adr/0013-recovery-code-device-authorization.md); this does not relax active-Device
checks on account-key mutations or protected content.

Password and passkey wrappers require a proven active Device (a Device proof, ADR 0020);
session-only recovery never discloses them.
