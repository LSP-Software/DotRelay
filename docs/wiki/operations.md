# Deployment, backup and recovery (pre-alpha)

This runbook applies to the source revision containing it. The repository is not
approved for an external alpha handling real secrets. Issue #36's independent
cryptographic/application-security review and exact-artifact release dossier remain
mandatory. CI, CodeRabbit and agent review do not constitute that review.

## GitHub App setup

Register a **GitHub App**, not a classic OAuth App. Configure the callback as
`https://YOUR_API_ORIGIN/api/auth/callback/github`, enable user authorization and
request only repository **Metadata: read** and user **Email addresses: read**.
Do not grant Contents, Actions, Administration or any write permission. Install
that App on **Only select repositories**; authorization and installation are
separate GitHub steps. The effective user token sees the intersection of User
and installation access. An organization owner may need to approve installation.
Set the App's `Iv…` client ID and client secret on the API. No App private key or
installation-wide service token is used by DotRelay.

Signing in installs nothing. GitHub shows the App only the repositories it is
installed on, so each user (or their organization owner) installs the App on
their own account and picks repositories. Make the App public ("Any account")
so they can. Set `GITHUB_APP_SLUG` on the API to the App's URL name (the `<slug>`
in `https://github.com/apps/<slug>`). The API then answers
`GET /api/v1/github-app` with
`{ "installUrl": "https://github.com/apps/<slug>/installations/new" }`; without
it the endpoint answers 404. The web app's first-run guide links there, and the
CLI adds the link to `repository_access_denied`. Without the slug they tell users
to ask you for the link.

GitHub App authorization has no classic OAuth `scope=repo`. Classic OAuth/PAT
credentials are refused by delegated access resolvers. Revoke old broad OAuth
grants in GitHub settings, remove their stored account grants and sign in with
the App again; changing the configuration alone does not revoke GitHub tokens.
Existing Repository Linkages retain their stable identities. Linking a new Project resolves the
repository with the acting User's own Delegated GitHub Access, and the repository names shown in
the workspace catalog are cached per viewer, so one User's access never reveals a private
repository's name to another. Never export tokens
to the CLI or browser. App registration/installation permissions and token expiry
must be checked by the operator with an actual test installation before launch.

## Configuration and startup

API images enforce `NODE_ENV=production` and require explicit `DATABASE_URL`,
`SERVER_PROFILE_ID`, `SERVER_PROFILE_ORIGIN`, `WEB_ORIGIN`, `BETTER_AUTH_SECRET`,
`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. Both origins must be HTTPS. Retain
the same Server Profile UUID through upgrades and restores. Generate a random
secret of at least 32 characters; never use the development example.
`DATABASE_URL_FILE`, `BETTER_AUTH_SECRET_FILE` and `GITHUB_CLIENT_SECRET_FILE`
accept private regular files (0600 or 0400), readable by UID 10001; configuring
both forms is an error. Do not place secrets in image build arguments or logs.

The image defaults to an empty, deny-all alpha list. Set `ALPHA_GITHUB_IDS` to
approved stable numeric IDs. Explicit `ALPHA_ADMISSION_REQUIRED=false` disables
admission, and must never be set accidentally. Behind TLS termination configure
`SERVER_PROFILE_TRUST_PROXY=true` and the exact trusted proxy CIDRs; prevent any
public direct access to the API container. Use a trusted proxy that overwrites
forwarding headers. Better Auth's sign-in limiter keys its buckets by client IP, which the API can
only learn from a trusted proxy: without `SERVER_PROFILE_TRUST_PROXY=true` and accurate
`SERVER_PROFILE_TRUSTED_PROXIES`, every client shares one bucket per auth route and a single
abusive client can lock everyone out of sign-in. When the web app and the API use sibling hosts, set
`COOKIE_DOMAIN` to their shared registrable domain (see [authentication](authentication.md)); give
each deployment on that domain its own `COOKIE_PREFIX`. Expose only the TLS proxy, keep PostgreSQL/Valkey private,
run API/web non-root with read-only roots, drop capabilities, set no-new-privileges,
apply memory/CPU/PID limits and provide bounded private `/tmp` tmpfs volumes.
The root `compose.yaml` is **development services only**, not a production bundle.

`/health` is process liveness. `/ready` checks PostgreSQL connectivity and exact
applied migration names/checksums, including failed migrations and unexpected
newer migrations; it returns only a generic 200 or 503. It has a three-second
response budget. When `VALKEY_URL` is set, readiness also pings Valkey.
`MAINTENANCE_MODE=true` makes readiness fail, as does SIGTERM, which then waits
`SHUTDOWN_DRAIN_MS` (default 5000) before closing the listener.

Valkey is required in production for rate limiting, and is shared by every API replica. Each
authenticated `/api/v1` request counts against its User's budget of 600 per minute. Requests that
may call GitHub on the User's behalf (`github-users/resolve`, `github-repositories/resolve`, the
workspace boundary) also count against 120 per minute, and requests that create durable rows
(Teams, Projects, invitations, Device enrollments) against 60 per hour. A refused request answers
`rate_limited` (429) with `Retry-After`. Without Valkey, production answers
`rate_limit_unavailable` (503); development runs unlimited. Better Auth's own per-IP sign-in limits
use the same Valkey, falling back to per-process memory if it is unreachable. Sessions slide for 30
days of inactivity but end 90 days after creation, browser and CLI alike. Keep health endpoints
on private monitoring paths where possible; see [Metrics and alerting](#metrics-and-alerting). The API process itself never migrates;
hosted deploys run a migration step before it starts (see below).
If the orchestrator overrides Docker's built-in healthcheck, configure
`bun /app/scripts/probe-health.ts` (liveness, `/health`) or
`bun /app/scripts/probe-ready.ts` (readiness) instead of an inherited curl/wget command;
the image's probe uses the pinned Bun runtime and needs no apt-installed client.

## Transactional email

The API sends three emails through [Resend](https://resend.com):

- **Invitation**, to the invitee: the expiry and a link to `/workspace` on `WEB_ORIGIN`, where the
  invitation, its Team and its inviter are shown and it is accepted or declined. Invitations
  address a GitHub id, so only an invitee who has already signed in to DotRelay has a stored
  address. Anyone else gets no email; the inviter still shares the invitation themselves.
- **Project keys shared**, to the Member, once per Share project keys operation (web Members view
  or `dotrelay team share-keys`), with the number of Projects and the `dotrelay pull` hint. Not
  one email per Device grant.
- **Invitation accepted**, to each active owner and admin of the Team except the new Member: that
  someone joined, the `dotrelay team share-keys` command for them, and that the Project keys must
  be shared before they can pull.

Subjects and headings are fixed text. No email names a Team, a person's display name, or a
repository: Members choose Team and display names, so mail from DotRelay's domain does not carry
their words, and a repository name resolved with one Member's GitHub access may be private to
them.

Recipients' addresses come from the GitHub primary email Better Auth stored at sign-in (the
GitHub App's **Email addresses: read** permission). GitHub `users.noreply.github.com` addresses
are skipped. The API never asks GitHub for an address at send time.

Emails are sent only after the database transaction commits, in the background: a slow or failed
send never fails or delays the API response. Each attempt times out after 10 seconds. A timeout,
network error, 429 or 5xx is retried once after two seconds with the same Resend
`Idempotency-Key`, so a retry never sends twice. Replays of an idempotent request send nothing. The
in-process queue holds at most 200 events; queued emails get up to two seconds to finish on
shutdown, then are dropped. Outcomes are the diagnostic events `api.email.sent`,
`api.email.failed` and `api.email.skipped` (see [observability](observability.md)), with an email
kind and a bounded reason only; never an address, link, name, key or Resend response.

Templates are short plain text with a minimal inline-styled HTML part. User-controlled strings are
escaped. There are no images or tracking pixels. Every email says why it was sent and that
replies are not read, and names the support address. Turn off open and click tracking for the
domain in Resend.

| Variable                | Default                           | Notes                                                                                                                                                                   |
| ----------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RESEND_API_KEY`        | unset                             | Unset turns email off (development, self-hosting, tests); the API logs one line at startup. A sending-only key is enough. `RESEND_API_KEY_FILE` accepts a private file. |
| `EMAIL_FROM`            | `DotRelay <noreply@dotrelay.dev>` | An address or `Name <address>` on a domain verified in Resend.                                                                                                          |
| `EMAIL_SUPPORT_ADDRESS` | `support@dotrelay.dev`            | Named in every email footer.                                                                                                                                            |

The production config check does not require email, but rejects a malformed value when one is
set.

### Resend domain and DNS

Add `dotrelay.dev` as a domain in the Resend dashboard (region of choice), then create the records
the dashboard lists. The exact values, including the DKIM public key and the MX host for the
region, come from the dashboard after the domain is added; copy them from there. The records are:

| Name                             | Type | Purpose                                                                                                      |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------ |
| `resend._domainkey.dotrelay.dev` | TXT  | DKIM public key (`p=…`) that signs mail from the domain.                                                     |
| `send.dotrelay.dev`              | MX   | Return-path (bounce) host for Resend's SES region, e.g. `feedback-smtp.<region>.amazonses.com`, priority 10. |
| `send.dotrelay.dev`              | TXT  | SPF for the return-path subdomain, `v=spf1 include:amazonses.com ~all`.                                      |
| `_dmarc.dotrelay.dev`            | TXT  | DMARC policy. Not issued by Resend; recommended below.                                                       |

Start DMARC in monitoring mode, `v=DMARC1; p=none; rua=mailto:<reports address>`, and move to
`p=quarantine` once reports show only aligned mail from Resend and any other senders on the
domain. Keep the apex SPF record unchanged; Resend's SPF lives on `send`. Wait for Resend to show
the domain as verified before setting `RESEND_API_KEY` in Coolify.

## Metrics and alerting

DotRelay sends no telemetry and has no access to self-hosted instances. Metrics are opt-in and
pulled by the operator's own Prometheus-compatible scraper.

Set `METRICS_ENABLED=true` to start a second, private listener on `METRICS_PORT` (default 9464).
It serves only `GET /metrics` in the Prometheus text format; it shares no routes, CORS, cookies or
sessions with the API on `PORT`. Production requires `METRICS_TOKEN` (at least 32 characters),
compared in constant time against `Authorization: Bearer <token>`; other requests get 401. Keep
`/health` and `/ready` on the API port for probes. The listener binds `METRICS_HOSTNAME`, which
defaults to `127.0.0.1`, so only a scraper on the same host reaches it. To scrape from another
container or host on a private network, set it to that interface (or `0.0.0.0` inside a container
network). Do not publish the metrics port or route it through the TLS proxy; scrape it from the
private network:

```yaml
scrape_configs:
  - job_name: dotrelay-api
    authorization:
      credentials_file: /etc/prometheus/dotrelay-metrics-token
    static_configs:
      - targets: ["api:9464"]
```

The metric names and the label policy are in [observability](observability.md#metrics).
Counters reset when the process restarts and are per replica; aggregate with `sum`.

`ops/alerts/dotrelay.rules.yml` has Prometheus alerting rules for: any expiry failure or failed
retention run in the last hour; Security Request Log write failures; a rate-limit refusal spike
(default: over 1 per second and 5 times the rate a day earlier, for 5 minutes); any
`rate_limit_unavailable`; readiness failing for 5 minutes; a missing scrape; and a 5xx ratio over
5% for 10 minutes. The thresholds are marked defaults; tune them to your traffic. Check edits with
`promtool check rules` and `promtool test rules ops/alerts/dotrelay.rules.test.yml`.

Without Prometheus, alert on the API's JSON log lines (stderr) instead. Each line has an
`eventName` and, for failures, `outcome: "failure"`. Alert on any
`api.staging.expiry_failed`, `api.security_request_log.expiry_failed`,
`api.retention.expiry_failed`, `api.retention.cleanup_completed` with `outcome: "failure"`,
`api.security_request_log.write_failed`, `api.rate_limit.unavailable`, or repeated
`api.readiness.checked` failures; and on a rising count of `api.rate_limit.user_refused`,
`github_refused`, `creation_refused` or `auth_refused`. `api.request.completed` lines carry the
`problemCode` of every failed request; successful requests are sampled.

## Upgrade and migrations

### Hosted deploys (Coolify)

Hosted deploys migrate automatically. `scripts/railpack-start.sh api` runs
`scripts/hosted-migrate.ts` and starts the API only if it exits 0. That step:

1. waits up to five minutes for the same PostgreSQL advisory lock that
   `deploy-migrate.ts` takes, so two starts (or a start and a manual run) never
   migrate at once;
2. runs the legacy-recovery guard **without an override**;
3. runs the installed Prisma `migrate deploy`.

Each step logs a `[migrate]` line to the container log. If any step fails it
logs `[migrate] FAILED at step: ...` and the container exits before the API
listens, so the deploy fails its health check. Nothing resolves or rolls back a
failed migration. Coolify keeps restarting the container, and each restart stops
at the same step until an operator fixes the database. Hosted deploys stop the
old container before starting the new one (no rolling updates), so an old API
never runs against a newer schema.

There is no deploy-time `pg_dump`: the shared Coolify PostgreSQL has scheduled
daily, weekly and monthly backups to S3. To recover from a failed migration,
prefer a reviewed forward repair; if that is impossible, restore the most recent
Coolify S3 backup into a new database. The deploy CI jobs no longer need a
manual migration receipt. See
[ADR 0016](../adr/0016-hosted-deploys-migrate-at-start.md).

### Self-hosted images and manual maintenance

The self-hosted image's entrypoint never migrates. Self-hosters (or an operator
who wants an encrypted backup taken immediately before a migration) use
`scripts/deploy-migrate.ts`:

1. Select the checked commit (and, for self-hosted images, the verified image
   digests). Retain old artifacts.
   Stop traffic and **all** writers (API replicas, jobs and maintenance commands).
   `DOTRELAY_WRITERS_STOPPED=true` is an operator assertion, not an automatic fence.
2. Use that revision's checkout, pinned Bun and `bun install --frozen-lockfile`.
   On the maintenance host provision PostgreSQL **17** clients, Python 3.11+ and
   `age` 1.x through your reviewed package source. Check `pg_dump --version`,
   `pg_restore --version` and `age --version`. Never dump with an older major client.
3. Supply `DATABASE_URL`, `BACKUP_AGE_RECIPIENT`, `BACKUP_IDENTITY_FILE`,
   `BACKUP_MAC_KEY_FILE` and a unique `BACKUP_ARCHIVE` in a private 0700 backup directory.
   The backup URL accepts only `sslmode`, `sslrootcert`, `sslcert` and `sslkey`
   query options. Remove Prisma-only options such as `schema` and
   `connection_limit` from this maintenance connection; configure supported TLS
   options or libpq environment variables explicitly. Unsupported options fail
   before migration. The identity is a private
   age key file; protect it independently and retain an offline recovery copy.
   Run `DOTRELAY_WRITERS_STOPPED=true bun scripts/deploy-migrate.ts`.
4. This process holds a PostgreSQL advisory lock, takes an encrypted `pg_dump`
   custom archive, checks its SHA-256, authenticates/decrypts it and checks the
   archive catalogue, then runs the legacy-recovery guard **without an override**,
   and only then the installed Prisma migration CLI. Any failure stops deployment.
   The wrapper never automatically resolves a failed migration or rolls it back.
5. If the legacy guard blocks, preserve the backup and inspect/export the legacy
   data separately under ADR-0011. The historical pre-production acknowledgement
   is not permission to discard a later durable deployment's data. Do not pass
   the override in an unattended deployment.
6. Start the exact API/web/CLI release together. Require `/ready`, public HTTPS
   `/api/v1/capabilities` (check profile UUID and suite), web and an authenticated
   synthetic encrypted round trip. Readiness does not prove key recovery or TLS.
   Only then enable traffic. Record the tested commit, any image digests, backup hash,
   restore rehearsal, operator and time in the deployment record.

For a failed migration keep writers stopped, retain the failed DB and backup,
and investigate. Prefer a reviewed forward repair. An older API refuses a newer
migration history; an image rollback is not a schema rollback. Restore to a new
DB if forward repair is impossible, following the process below.

## Backup and restore

With explicit environment settings above, run:

```sh
python3 ops/postgres.py backup /private-backups/unique-name.age
python3 ops/postgres.py verify /private-backups/unique-name.age
```

Backups are age-encrypted PostgreSQL custom archives with a `.json` manifest
sidecar. Both must be retained. Encryption to a public age recipient does not say who
made an archive, so the manifest records the archive's SHA-256 and size, its file name, its
creation time and the source database (host, port and name) under an HMAC-SHA256 keyed by
`BACKUP_MAC_KEY_FILE`: a private (`0600`) file holding at least 32 random bytes, for example
`openssl rand -hex 32`. Keep that key with the age identity and never on backup storage;
whoever can write backup storage can replace an archive and its checksum, but not forge the
MAC, and cannot rename an older authentic archive over a newer one, because the manifest names
the file it was written for. `verify` and `restore` refuse an archive whose manifest does not
authenticate before anything is decrypted, and print its authenticated creation time; check it
is the backup you meant to restore. Archives made before manifests were authenticated (manifest
version 1) are refused unless the operator sets `DOTRELAY_ALLOW_UNAUTHENTICATED_BACKUP=true`
for that run after confirming the storage was not writable by anyone else. Archives authenticated
before the name, time and source were bound (manifest version 2) need
`DOTRELAY_ALLOW_UNBOUND_BACKUP=true` for that run, after confirming no older archive was renamed
over them. The pipeline checks both `pg_dump` and encryption
exit codes; any failed output is unusable. Names are exclusive: a backup never
overwrites another backup. Store copies outside the database host, encrypt disks,
restrict access, monitor failures and capacity, and set retention/RPO/RTO appropriate
to your deployment. Valkey is disposable and is not backed up. Database backups
contain encrypted OAuth credentials and sensitive metadata despite E2EE; preserve
the matching `BETTER_AUTH_SECRET` separately. Backups never recover missing client
keys or Recovery Codes.

Catalogue verification alone is insufficient. Rehearse restore into an isolated
network using a newly created empty database and the matching release. Set
`RESTORE_DATABASE_URL` to that target and run:

```sh
DOTRELAY_WRITERS_STOPPED=true python3 ops/postgres.py restore /private-backups/unique-name.age
```

Restore first authenticates the manifest and the complete encrypted archive and refuses
an unauthenticated manifest, a checksum mismatch or a nonempty target. Restore as a role
that owns the new target database but is not a superuser, so the archive's SQL runs with
no more privilege than the application needs. It uses `pg_restore --single-transaction` and
`--exit-on-error`, without `--clean`, without dropping or overwriting the original
DB. Preserve ownership/privileges by provisioning the dedicated role separately;
archives intentionally omit role/ACL recreation. Verification uses an unlinked private
temporary file to bound memory; the maintenance host needs sufficient private,
encrypted temporary storage. Keep all target traffic and writers
stopped during verification; a restore failure must leave the target offline.

Verify migration history, Server Profile UUID/origin, ciphertext bytes, counts,
authentication and client decryptability. Preserve the original DB and recoverable
backup until validation finishes. Quarantine copied auth sessions/device codes
before reconnecting users; do not start serving stale sessions. Account for data
written after the backup and warn affected Users. Clients must retain their trusted
history and reject rollback; never auto-clear pins to make a restored DB appear
healthy. Follow the explicit per-Environment History Trust Reset workflow documented
in [client trust](client-trust.md) only after affected Users understand the lost
history. A full operator recovery-mode/affected-Environment report is still tracked
in #32; do not infer it from database readiness.

## Reproducibility and promotion

The Docker bases and PostgreSQL/Valkey service images are digest-pinned. The API image,
the web build, the compiled CLI and CI run the stable Bun release `1.4.4`, revision
`38afee6c84fcf48c0edb2466aa4b27d287a59c30` (`oven/bun:1.4.4@sha256:1d22548f…`); Docker
verifies its reported revision. The matching Linux x64 Bun archive SHA-256 is
`93ca5a2abe45f3bcac6dd55baff8bb06c4ac824b70f89650b54e5c8b80dbef18`. CI installs the
official, immutable npm packages `@oven/bun-*@1.4.4`, verifies their SHA-512 integrity
from `ops/bun-toolchain.json` and checks the executable revision before use. A dated
canary (`@oven/bun-*@1.4.4-canary.20261030.1`, revision
`da867c60bf0bcbf9d6d36994f8ca0efa42075115`) is pinned the same way, but only runs the
built-in `bun lint`; it never builds or runs anything that ships. Direct package versions and transitive resolutions are locked; installs must use
`--frozen-lockfile`. Pin changes require the full runtime/crypto matrix again.
This is repeatable dependency resolution, not a claim of bit-for-bit reproducible
Next.js/native binaries across different hosts.

Release images are public on Docker Hub as `lspsoftware/dotrelay-api` and
`lspsoftware/dotrelay-web`. They attach SBOM/provenance and are for self-hosted
operators. Self-hosters should record and promote exact image digests, not
mutable tags, and retain the CLI artifact hashes.

DotRelay's hosted deployments do not pull images. Coolify builds the API and
web apps from Git with railpack: `railpack.json` pins the runtime Bun and Node,
and `scripts/railpack-build.sh` and `scripts/railpack-start.sh` reproduce the
Dockerfile build and the non-root start. The apps track `main` with auto-deploy
off. CI pins them to an exact commit (`git_commit_sha`) through the Coolify API
and then deploys: dev gets each `main` commit that passes CI, production gets
the commit a stable tag points at. The API applies that commit's pending
migrations when it starts (see [Hosted deploys](#hosted-deploys-coolify)). The web app's `NEXT_PUBLIC_*` values are
build-time variables in Coolify, set per environment.

Releases package each CLI platform into a unique timestamp-normalized archive,
attach `SHA256SUMS` and a `release-manifest.json` binding source SHA (which is
also the hosted deploy commit), toolchain/integrity pins, dependency lock hash,
CLI bytes and the independent-review report hash.
GitHub OIDC signs provenance for those exact release files; the already-built
binaries are packaged and promoted without recompilation. Download the provenance
bundle and verify each archive and the manifest with
`gh attestation verify FILE --repo LSP-Software/DotRelay`, then run
`sha256sum --check SHA256SUMS` from the directory containing all release files.
Keep an offline copy of the verified manifest, attestations and artifacts.
Do not treat a mutable channel alias as evidence of a verified deployment.

The `security-review` environment must have required independent reviewers.
`SECURITY_REVIEW_APPROVED_SHA` must identify the exact reviewed source commit;
the old reusable `approved` flag is insufficient. Set
`SECURITY_REVIEW_REPORT_SHA256` to the actual independent report's SHA-256;
publication refuses missing or malformed report metadata. Record reviewer, report hash,
artifact identities and finding disposition separately. No independent approval
is supplied by this change. Critical/high findings and unresolved crypto-boundary
medium findings block real-secret releases.

The receipt-digest migration `20261030000000_publication_receipt_digest` is additive.
It binds new publication receipts to their normalized finalize requests without
changing signed v3 objects. Older committed operations have no fingerprint and
fail closed on `/finalize` replay; current clients use the authenticated operation
receipt to confirm those outcomes. Do not edit earlier migration checksums.
