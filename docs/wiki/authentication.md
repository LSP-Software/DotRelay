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
is terminated by a trusted reverse proxy, set `SERVER_PROFILE_TRUST_PROXY=true`; the API otherwise
rejects forwarded HTTPS claims and requires its direct request URL to be HTTPS.

The Server Profile id is an opaque, immutable UUID stored in PostgreSQL and returned with the
canonical origin by `/api/v1/capabilities`. Clients pin both values after explicit trust. A changed
id at the same origin is an identity failure; moving a profile requires an explicit rebind with the
same pinned id. Set `SERVER_PROFILE_REBIND=true` only for that deliberate startup rebind; normal
startup fails closed rather than silently changing the persisted profile identity. The API never
discovers a profile through an ambient redirect.

Browser sessions use secure HttpOnly same-site cookies and exact-origin credentialed CORS. State
changing cookie requests must come from the configured web or Server Profile origin. CLI sessions
use a Better Auth bearer token returned by device authorization and should be stored in the operating
system credential store. A request containing both a bearer token and a cookie is rejected.

Authentication establishes only the server-local DotRelay User. It does not grant Membership,
Device authority, decryption ability, or mutation permission. Encrypted operations still require an
active Device and the application-level signed protocol checks. Session expiry, logout, and remote
revocation are database-backed and take effect on the next request.

The capabilities response is public and may be cached briefly with its ETag. Authenticated
responses are `no-store`. Errors use the stable `application/problem+json` contract and never
include stack traces, bearer credentials, OAuth tokens, plaintext, or cryptographic component
details.
