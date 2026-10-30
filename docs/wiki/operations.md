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

GitHub App authorization has no classic OAuth `scope=repo`. Classic OAuth/PAT
credentials are refused by delegated access resolvers. Revoke old broad OAuth
grants in GitHub settings, remove their stored account grants and sign in with
the App again; changing the configuration alone does not revoke GitHub tokens.
Existing Repository Linkages retain their stable identities. Never export tokens
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
forwarding headers. Expose only the TLS proxy, keep PostgreSQL/Valkey private,
run API/web non-root with read-only roots, drop capabilities, set no-new-privileges,
apply memory/CPU/PID limits and provide bounded private `/tmp` tmpfs volumes.
The root `compose.yaml` is **development services only**, not a production bundle.

`/health` is process liveness. `/ready` checks PostgreSQL connectivity and exact
applied migration names/checksums, including failed migrations and unexpected
newer migrations; it returns only a generic 200 or 503. It has a three-second
response budget. `MAINTENANCE_MODE=true` makes readiness fail. Keep health endpoints
on private monitoring paths where possible. Production startup never migrates.

## Upgrade and migrations

1. Select the checked commit and verified image digests. Retain old artifacts.
   Stop traffic and **all** writers (API replicas, jobs and maintenance commands).
   `DOTRELAY_WRITERS_STOPPED=true` is an operator assertion, not an automatic fence.
2. Use that revision's checkout, pinned Bun and `bun install --frozen-lockfile`.
   On the maintenance host provision PostgreSQL **17** clients, Python 3.11+ and
   `age` 1.x through your reviewed package source. Check `pg_dump --version`,
   `pg_restore --version` and `age --version`. Never dump with an older major client.
3. Supply `DATABASE_URL`, `BACKUP_AGE_RECIPIENT`, `BACKUP_IDENTITY_FILE` and a unique
   `BACKUP_ARCHIVE` in a private 0700 backup directory. The identity is a private
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
   Only then enable traffic. Record the tested commit, image digests, backup hash,
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

Backups are age-encrypted PostgreSQL custom archives with a `.json` checksum
sidecar. Both must be retained. The pipeline checks both `pg_dump` and encryption
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

Restore first authenticates the complete encrypted archive and refuses checksum
mismatch or a nonempty target. It uses `pg_restore --single-transaction` and
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

The Docker bases and PostgreSQL/Valkey service images are digest-pinned. CI Bun is
pinned to revision `da867c60bf0bcbf9d6d36994f8ca0efa42075115`; Docker verifies its
reported revision. The matching Linux x64 Bun archive SHA-256 is
`e8f27b24f74186e87fc0f0f603bdb6b79264dc86a1680da41e2025a3cb3efee0`.
Direct package versions and transitive resolutions are locked; installs must use
`--frozen-lockfile`. Pin changes require the full runtime/crypto matrix again.
This is repeatable dependency resolution, not a claim of bit-for-bit reproducible
Next.js/native binaries across different hosts.

Release images attach SBOM/provenance. Record and promote exact image digests,
not mutable tags, and retain the CLI artifact hashes. Hosted deployment requires
an operator migration receipt for the exact source SHA (`DEV_MIGRATED_COMMIT_SHA`
or `PRODUCTION_MIGRATED_COMMIT_SHA`). Configure Coolify to consume the reviewed
image digests before acknowledging that receipt. A full signed compatibility
manifest, offline artifact verification and build-once promotion remain #32/#36
gates. Do not treat a mutable channel alias as evidence of a verified deployment.

The `security-review` environment must have required independent reviewers.
`SECURITY_REVIEW_APPROVED_SHA` must identify the exact reviewed source commit;
the old reusable `approved` flag is insufficient. Record reviewer, report hash,
artifact identities and finding disposition separately. No independent approval
is supplied by this change. Critical/high findings and unresolved crypto-boundary
medium findings block real-secret releases.
