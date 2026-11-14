#!/bin/sh
# Build one DotRelay app inside a railpack image (Coolify's hosted deploys).
# The Dockerfiles in apps/*/ remain the self-hosted images; this script
# reproduces their build steps. Usage: scripts/railpack-build.sh api|web
set -eu

case "${1:-}" in
  api)
    bun run --cwd apps/api build
    ;;
  web)
    # NEXT_PUBLIC_* values are baked in here, so Coolify must pass them as
    # build-time variables for each environment.
    bun run --cwd apps/web build
    # Standalone output leaves out static assets and public/ (which holds the
    # Argon2 worker), so copy them next to server.js as the Dockerfile does.
    standalone=apps/web/.next/standalone/apps/web
    rm -rf "$standalone/.next/static" "$standalone/public"
    cp -R apps/web/.next/static "$standalone/.next/static"
    cp -R apps/web/public "$standalone/public"
    ;;
  *)
    echo "usage: $0 api|web" >&2
    exit 64
    ;;
esac
