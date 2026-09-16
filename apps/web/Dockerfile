# syntax=docker/dockerfile:1
# DotRelay Web (Next.js, output: "standalone"). Build context = repository
# root (bun workspaces resolve at the root). The two NEXT_PUBLIC_* values are
# baked in at build time; CI passes them per environment (dev vs prod
# origins), so the web image is environment-specific.
FROM oven/bun:1.4.0 AS builder

ARG NEXT_PUBLIC_WEB_ORIGIN
ARG NEXT_PUBLIC_DOTRELAY_API_ORIGIN
ENV NEXT_PUBLIC_WEB_ORIGIN=${NEXT_PUBLIC_WEB_ORIGIN} \
    NEXT_PUBLIC_DOTRELAY_API_ORIGIN=${NEXT_PUBLIC_DOTRELAY_API_ORIGIN}

WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --cwd apps/web build

# Runtime: Next.js standalone output is a plain Node process.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app
# Monorepo standalone layout: the standalone root mirrors the repository
# (minimal traced node_modules at the root, the app under apps/web).
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
# This repository has no apps/web/public directory, so there is no public
# asset copy to make.

WORKDIR /app/apps/web
EXPOSE 3000
CMD ["node", "server.js"]
