# DotRelay Web (Next.js, output: "standalone"). Build context = repository
# root (bun workspaces resolve at the root). The NEXT_PUBLIC_* values are
# baked in at build time; CI passes them per environment (dev vs prod
# origins, and the profile DotRelay's own deployments declare), so the web
# image is environment-specific.
FROM oven/bun@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS builder

ARG NEXT_PUBLIC_WEB_ORIGIN
ARG NEXT_PUBLIC_DOTRELAY_API_ORIGIN
ARG NEXT_PUBLIC_DOTRELAY_WEB_PROFILE
ENV NEXT_PUBLIC_WEB_ORIGIN=${NEXT_PUBLIC_WEB_ORIGIN} \
    NEXT_PUBLIC_DOTRELAY_API_ORIGIN=${NEXT_PUBLIC_DOTRELAY_API_ORIGIN} \
    NEXT_PUBLIC_DOTRELAY_WEB_PROFILE=${NEXT_PUBLIC_DOTRELAY_WEB_PROFILE}

WORKDIR /app
COPY . .
RUN test "$(bun --revision)" = "1.4.4-canary.1+da867c60b" && bun install --frozen-lockfile
RUN bun run --cwd apps/web build

# Runtime: Next.js standalone output is a plain Node process.
FROM node@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

# The profile declaration travels with the image so the server-side boundary
# route resolves the same Server Profile the client bundle was built with,
# even before an orchestrator's environment is updated. Orchestrator-provided
# values still win over these defaults.
ARG NEXT_PUBLIC_DOTRELAY_WEB_PROFILE
ENV NODE_ENV=production \
    NEXT_PUBLIC_DOTRELAY_WEB_PROFILE=${NEXT_PUBLIC_DOTRELAY_WEB_PROFILE}
WORKDIR /app
# Monorepo standalone layout: the standalone root mirrors the repository
# (minimal traced node_modules at the root, the app under apps/web).
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
# Standalone output does not include public/, which holds the Argon2 worker
# bundle (argon2-worker.js) the browser fetches before unlocking keys.
COPY --from=builder --chown=node:node /app/apps/web/public ./apps/web/public

WORKDIR /app/apps/web
# Run as the non-root node user shipped with the image; the standalone tree is
# chown'd above so the server has read (and any runtime cache) access.
USER node
EXPOSE 3000
# Bind on all interfaces so the in-container health probe can reach the server
# on loopback (Docker sets HOSTNAME to the container id otherwise).
ENV HOSTNAME=0.0.0.0
HEALTHCHECK --interval=10s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server.js"]
