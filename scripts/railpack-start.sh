#!/bin/sh
# Start one DotRelay app inside a railpack image as the unprivileged UID 10001,
# with the same defaults as the Dockerfiles. Railpack images run as root, so
# this drops privileges before the app starts. Usage: railpack-start.sh api|web
set -eu

app_uid=10001
export HOME=/tmp
: "${NODE_ENV:=production}"
export NODE_ENV

case "${1:-}" in
  api)
    # Alpha deployments fail closed if the operator forgets the admission list.
    : "${ALPHA_ADMISSION_REQUIRED:=true}"
    : "${ALPHA_GITHUB_IDS:=}"
    export ALPHA_ADMISSION_REQUIRED ALPHA_GITHUB_IDS
    set -- sh scripts/api-entrypoint.sh
    ;;
  web)
    cd apps/web/.next/standalone/apps/web
    # Next.js writes its image and fetch caches here.
    mkdir -p .next/cache
    if [ "$(id -u)" = 0 ]; then chown -R "$app_uid:$app_uid" .next/cache; fi
    # Bind on all interfaces so the health probe can reach the server on
    # loopback (Docker sets HOSTNAME to the container id otherwise).
    export HOSTNAME=0.0.0.0
    set -- node server.js
    ;;
  *)
    echo "usage: $0 api|web" >&2
    exit 64
    ;;
esac

if [ "$(id -u)" = 0 ]; then
  exec setpriv --reuid="$app_uid" --regid="$app_uid" --clear-groups --no-new-privs -- "$@"
fi
exec "$@"
