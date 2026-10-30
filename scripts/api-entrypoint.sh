#!/bin/sh
set -eu
# Refuse accidental development-mode overrides in a production image.
[ "$NODE_ENV" = production ] || { echo 'API image requires production mode' >&2; exit 1; }
exec bun run scripts/start-api.ts
