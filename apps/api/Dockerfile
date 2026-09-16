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

# Unprivileged runtime user. The API only reads /app (code, migrations, the
# generated Prisma client) and reaches the database over the network, so it
# needs no root capabilities or write access.
RUN groupadd --gid 10001 dotrelay && \
    useradd --uid 10001 --gid dotrelay --home-dir /app --no-create-home dotrelay

# WORKDIR creates /app (useradd used --no-create-home, so nothing else does).
# HOME is /app for the runtime user; own the directory itself as well (COPY
# --chown covers the tree contents, not the workdir) so prisma/bun can write
# a home cache when running unprivileged.
WORKDIR /app
RUN chown dotrelay:dotrelay /app
COPY --from=builder --chown=dotrelay:dotrelay /app .

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
USER dotrelay
ENTRYPOINT ["/entrypoint.sh"]
