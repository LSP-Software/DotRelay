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
app and the API are served from different hosts on the same registered domain (for example
`dev.dotrelay.dev` and `dev-api.dotrelay.dev`), the cookies are additionally scoped to the shared
parent domain so the browser presents the session cookie to both origins and the web app's
server-side session relay can forward it to the API. When both origins share a host, cookies stay
host-only. CLI sessions
use a Better Auth bearer token returned by device authorization and should be stored in the CLI's
local credential store (encrypted files in the CLI state directory). A request containing both a
bearer token and a cookie is rejected.

Authentication establishes only the server-local DotRelay User. It does not grant Membership,
Device authority, decryption ability, or mutation permission. Encrypted operations still require an
active Device and the application-level signed protocol checks. Session expiry, logout, and remote
revocation are database-backed and take effect on the next request.

The user-facing login journey continues after GitHub verification. The browser gates the workspace
until it has a durable Device key and can open the Account Master Key; returning browsers restore a
Device-sealed local copy. CLI login enrolls and unlocks the Device before reporting success. In
noninteractive CLI setup of an existing account, it exits with a specific locked-key error and the
`dotrelay device recover` command to finish the journey. An OAuth session may briefly exist during
these steps because it is required to fetch encrypted wrappers; it never grants decryption by itself.

Better Auth permits ten requests to one authentication route in a 60-second window. Device codes
expire after 30 minutes and the CLI must wait at least five seconds between token polls; an early
poll returns `slow_down`. The limiter uses per-process memory. A single API process is suitable for
the MVP. A multi-replica deployment must add an edge or shared-store limit before accepting traffic.
In production, requests without a trusted client address share one conservative route bucket. The
API reads `X-Forwarded-For` only when trusted proxies are configured, and walks the chain past the
listed proxy addresses. A `429` response carries `X-Retry-After`, which auth CORS exposes.

The capabilities response is public and may be cached briefly with its ETag. Authenticated
responses are `no-store`. Errors use the stable `application/problem+json` contract and never
include stack traces, bearer credentials, OAuth tokens, plaintext, or cryptographic component
details.

## Security review record

The auth tables and opaque DotRelay User table have separate identifiers. A successful GitHub
callback creates or updates Better Auth records; `/api/v1/session` resolves the GitHub subject to a
server-local DotRelay User without granting a Membership or authorizing a Device. Better Auth
encrypts stored OAuth tokens. The CLI receives only its database-backed session token.

Cookie and bearer credentials are separate request modes. Browser state changes need an exact
configured Origin, and production cookies are Secure, HttpOnly, and SameSite=Lax. CLI bearer
requests do not need a browser Origin. The API rejects a request that combines either mode. Better
Auth's cookie cache is disabled, so logout, expiry, and remote session deletion take effect on the
next request instead of waiting for a signed-cookie cache to expire.

The integration tests cover the exact GitHub callback, OAuth state rejection, secure cookie
attributes, cross-subdomain cookie scoping, exact-origin CORS and CSRF failures, mixed credentials,
device polling and expiry, endpoint limiting, logout, remote revocation, session expiry,
capabilities ETags, profile rebinding, and suite or runtime refusal before credential access.
