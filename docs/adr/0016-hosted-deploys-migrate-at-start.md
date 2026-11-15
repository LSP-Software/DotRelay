# Hosted deploys migrate at start

Status: accepted

Hosted DotRelay (the Coolify dev and production apps) applies pending database
migrations as part of every deploy. An operator no longer runs
`scripts/deploy-migrate.ts` by hand and records a `*_MIGRATED_COMMIT_SHA`
receipt before CI may deploy.

## Decision

`scripts/railpack-start.sh api` runs `scripts/hosted-migrate.ts`, then starts
the API only if it succeeded. The step takes the deployment advisory lock
(waiting for it), runs the legacy-recovery guard without an override
([ADR 0011](0011-legacy-recovery-cutover-is-destructive-and-guarded.md)), then
the installed `prisma migrate deploy`. Any failure is logged and the container
exits before the API listens. Nothing resolves or rolls back a failed migration.

The `DEV_MIGRATED_COMMIT_SHA` and `PRODUCTION_MIGRATED_COMMIT_SHA` gates in
`ci.yml` and `release.yml` are removed. The security-review gate stays.

## Why at start, not Coolify's pre-deployment command

Coolify runs a `pre_deployment_command` with `docker exec` in the container that
is already running, which holds the previous commit's code and migrations, and
skips it when no container is running (a first deploy, or an API that crashed).
Neither applies the new commit's migrations reliably. The start step runs inside
the new image, every time.

## Consequences

- Hosted deploys take no deploy-time encrypted `pg_dump`. The shared Coolify
  PostgreSQL has scheduled daily, weekly and monthly backups to S3, and those are
  the restore point.
- The hosted apps have no rolling updates: Coolify stops the old container first,
  so an old API never runs against the newer schema. If rolling updates are ever
  turned on, migrations must stay backward compatible with the previous release.
- A failed migration leaves the API down until an operator repairs the database.
- The self-hosted image is unchanged: its entrypoint never migrates, and
  `scripts/deploy-migrate.ts` remains the backed-up path for self-hosters and
  manual maintenance.
