# DotRelay API (Bun/Hono). Build context = repository root: bun workspaces
# and the Prisma client generation (postinstall) resolve at the root.
FROM oven/bun@sha256:14e08ed749dcfb986e6c05b59ac45a991952e3ef846b9e86c4b09a3ac41cf979 AS builder

WORKDIR /app
COPY . .
RUN test "$(bun --revision)" = "1.4.4-canary.1+da867c60b" && bun install --frozen-lockfile
# Build only the API: bun bundles the workspace dependencies from source, so
# turbo and the Next.js web build are not needed for this image.
RUN bun run --cwd apps/api build

# Runtime. The full builder tree (node_modules, built API, @dotrelay/database
# with its migrations and generated Prisma client) is copied over so that
# `bun x prisma` resolves from the root node_modules at deploy time.
FROM oven/bun@sha256:14e08ed749dcfb986e6c05b59ac45a991952e3ef846b9e86c4b09a3ac41cf979

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

# Migrations are a separate, backed-up maintenance operation.
COPY scripts/api-entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh
ENV NODE_ENV=production
HEALTHCHECK --interval=10s --timeout=5s --retries=3 CMD ["bun", "scripts/probe-ready.ts"]

# Alpha images fail closed if the operator forgets the admission list.
# Public/self-hosted operators may explicitly opt out with false.
ENV ALPHA_ADMISSION_REQUIRED=true ALPHA_GITHUB_IDS=""
EXPOSE 3001
USER dotrelay
ENTRYPOINT ["/entrypoint.sh"]
