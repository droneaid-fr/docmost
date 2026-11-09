#!/usr/bin/env bash
# Migration bundle -> Docmost (Docmost migration S6b). See README.md.
#
#   ./run.sh import --bundle DIR [--out DIR] [--skip-trashed] [--verify] [CLI flags]
#   ./run.sh verify --bundle DIR [--out DIR]      # check an import against its bundle
#   ./run.sh reset-local --yes                    # LOCAL dev DB only: empty DB + storage, migrate
#   ./run.sh test                                 # unit tests of the mapping functions
#
# Runs the built server's import CLI (apps/server/dist/droneaid/migration/import-cli.js)
# from apps/server, so it reads the root .env and the same storage as the server.
# Build first: pnpm editor-ext:build && (cd apps/server && npx nest build).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
server=$repo/apps/server
cap=(systemd-run --user --scope -q -p MemoryMax=${IMPORT_MEMORY_MAX:-6G} -p MemorySwapMax=1G)

env_value() { grep -E "^$1=" "$repo/.env" 2>/dev/null | tail -1 | cut -d= -f2-; }

cmd=${1:-}; shift || true
case $cmd in
  test)
    cd "$server"
    exec "${cap[@]}" npx jest --maxWorkers=2 --workerIdleMemoryLimit=1G src/droneaid/migration src/droneaid/agents "$@"
    ;;
  reset-local)
    [[ ${1:-} == --yes ]] || { echo "reset-local deletes every page, user and file: pass --yes" >&2; exit 1; }
    db=$(env_value DATABASE_URL)
    [[ $db =~ @(localhost|127\.0\.0\.1): ]] || { echo "refusing: DATABASE_URL is not local ($db)" >&2; exit 1; }
    psql_url=${db%%\?*}
    if command -v psql >/dev/null; then
      psql "$psql_url" -v ON_ERROR_STOP=1 -c 'drop schema public cascade; create schema public;'
    else
      container=${RESET_PG_CONTAINER:?psql not installed: set RESET_PG_CONTAINER (e.g. docmost-s6-pg)}
      docker exec "$container" psql -U docmost -d docmost -v ON_ERROR_STOP=1 \
        -c 'drop schema public cascade; create schema public;'
    fi
    redis=$(env_value REDIS_URL)
    if [[ -n ${RESET_REDIS_CONTAINER:-} ]]; then docker exec "$RESET_REDIS_CONTAINER" redis-cli FLUSHALL >/dev/null; fi
    rm -rf "$repo/data/storage"
    cd "$server" && "${cap[@]}" npx tsx src/database/migrate.ts latest
    echo "reset done (redis: ${redis:-unset}; flush it with RESET_REDIS_CONTAINER=<name>)"
    ;;
  import|verify)
    avail=$(free -g | awk '/^Mem:/ {print $7}')
    if (( avail < 8 )); then echo "only ${avail} GB available (< 8): wait" >&2; exit 1; fi
    [[ -f $server/dist/droneaid/migration/import-cli.js ]] || { echo "build the server first (see header)" >&2; exit 1; }
    extra=()
    [[ $cmd == verify ]] && extra=(--verify-only)
    umask 077
    cd "$server"
    exec "${cap[@]}" env NODE_ENV=production node dist/droneaid/migration/import-cli.js "$@" "${extra[@]}"
    ;;
  *)
    sed -n '2,12p' "$0" >&2; exit 1 ;;
esac
