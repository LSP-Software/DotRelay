#!/bin/bash
set -euo pipefail
sudo apt-get update
sudo apt-get install -y age
# Use the same digest-pinned PostgreSQL clients as the server, rather than
# the runner's older system pg_dump. No database credentials enter argv.
python3 <<'PY'
import os
from pathlib import Path
folder = Path(os.environ["RUNNER_TEMP"]) / "pg-tools"
folder.mkdir(exist_ok=True)
image = "postgres@sha256:a426e44bac0b759c95894d68e1a0ac03ecc20b619f498a91aae373bf06d8508d"
for tool in ("psql", "pg_dump", "pg_restore"):
    script = folder / tool
    script.write_text('#!/bin/sh\nexec docker run --rm -i --network host --env PGHOST --env PGPORT --env PGDATABASE --env PGUSER --env PGPASSWORD --env PGCONNECT_TIMEOUT --env PGSSLMODE ' + image + ' ' + tool + ' "$@"\n')
    script.chmod(0o700)
with open(os.environ["GITHUB_PATH"], "a") as out:
    out.write(str(folder) + "\n")
PY
