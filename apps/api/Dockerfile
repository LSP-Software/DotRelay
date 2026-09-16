# syntax=docker/dockerfile:1
# DotRelay API (Bun/Hono). Build context = repository root: bun workspaces
# and the Prisma client generation (postinstall) resolve at the root.
FROM oven/bun:1.4.0 AS builder

WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
# Build only the API: bun bundles the workspace dependencies from source, so
# turbo and the Next.js web build are not needed for this image.
RUN bun run --cwd apps/api build

# Runtime. The full builder tree (node_modules, built API, @dotrelay/database
# with its migrations and generated Prisma client) is copied over so that
# `bun x prisma` resolves from the root node_modules at deploy time.
FROM oven/bun:1.4.0

WORKDIR /app
COPY --from=builder /app .

# Entrypoint: apply committed Prisma migrations, then hand the process slot to
# the API (exec keeps SIGTERM handling with the Bun runtime).
RUN printf '%s\n' \
      '#!/bin/sh' \
      'set -e' \
      'echo "[entrypoint] applying prisma migrations" >&2' \
      'bun x prisma migrate deploy --config packages/database/prisma.config.ts' \
      'exec bun run apps/api/dist/index.js' \
    > /entrypoint.sh && chmod 755 /entrypoint.sh

EXPOSE 3001
ENTRYPOINT ["/entrypoint.sh"]
