# syntax=docker/dockerfile:1
# DotRelay Web (Next.js, output: "standalone"). Build context = repository
# root (bun workspaces resolve at the root). The NEXT_PUBLIC_* values are
# baked in at build time; CI passes them per environment (dev vs prod
# origins, and the profile DotRelay's own deployments declare), so the web
# image is environment-specific.
FROM oven/bun:1.4.2 AS builder

ARG NEXT_PUBLIC_WEB_ORIGIN
ARG NEXT_PUBLIC_DOTRELAY_API_ORIGIN
ARG NEXT_PUBLIC_DOTRELAY_WEB_PROFILE
ENV NEXT_PUBLIC_WEB_ORIGIN=${NEXT_PUBLIC_WEB_ORIGIN} \
    NEXT_PUBLIC_DOTRELAY_API_ORIGIN=${NEXT_PUBLIC_DOTRELAY_API_ORIGIN} \
    NEXT_PUBLIC_DOTRELAY_WEB_PROFILE=${NEXT_PUBLIC_DOTRELAY_WEB_PROFILE}

WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --cwd apps/web build

# Runtime: Next.js standalone output is a plain Node process.
FROM node:22-alpine

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
# This repository has no apps/web/public directory, so there is no public
# asset copy to make.

WORKDIR /app/apps/web
# Run as the non-root node user shipped with the image; the standalone tree is
# chown'd above so the server has read (and any runtime cache) access.
USER node
EXPOSE 3000
CMD ["node", "server.js"]
