#!/usr/bin/env bash
# AFFiNE -> migration bundle (Docmost migration S6a). See README.md.
#
#   ./run.sh --source-backup affine-20261108T213045Z [--out DIR] [extra main.ts flags]
#   ./run.sh test        # unit tests of the pure transforms
#
# Runs the exporter inside the AFFiNE fork's TypeScript runtime (its SWC
# register hook, its yjs, prisma and native reader). The AFFiNE server does not
# need to run; only the restored Postgres must be up.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)

# base/ = the directory holding affine/AFFiNE and backups/ (searched upwards).
base=${DRONEAID_BASE:-}
if [[ -z $base ]]; then
  d=$here
  while [[ $d != / && ! -d $d/affine/AFFiNE ]]; do d=$(dirname "$d"); done
  [[ -d $d/affine/AFFiNE ]] || { echo "set DRONEAID_BASE (dir containing affine/AFFiNE)" >&2; exit 1; }
  base=$d
fi
fork=${AFFINE_FORK:-$base/affine/AFFiNE}
server=$fork/packages/backend/server
selfhost=${AFFINE_SELFHOST:-$base/affine/affine-selfhost}
export PATH="${AFFINE_NODE_BIN:-$HOME/.nvm/versions/node/v22.23.2/bin}:$PATH"

# Memory rule of the migration plan: every heavy process under a cgroup cap.
cap=(systemd-run --user --scope -q -p MemoryMax=${EXPORT_MEMORY_MAX:-6G} -p MemorySwapMax=1G)
node_ts=(node --import="$fork/tools/cli/register.js")

if [[ ${1:-} == test ]]; then
  shift
  cd "$server"
  exec "${cap[@]}" env AFFINE_SERVER="$server" "${node_ts[@]}" --test "$here"/test/*.test.ts "$@"
fi

avail=$(free -g | awk '/^Mem:/ {print $7}')
if (( avail < 8 )); then echo "only ${avail} GB available (< 8): wait" >&2; exit 1; fi

ts=$(date -u +%Y%m%dT%H%M%SZ)
out=$base/backups/migration-bundle-$ts
args=()
while (($#)); do
  case $1 in
    --out) out=$2; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
backup_manifest=()
src=""
for ((i=0; i<${#args[@]}; i++)); do [[ ${args[i]} == --source-backup ]] && src=${args[i+1]:-}; done
if [[ -n $src && -f $base/backups/$src/MANIFEST ]]; then
  backup_manifest=(--backup-manifest "$base/backups/$src/MANIFEST")
fi

umask 077
cd "$server"
exec "${cap[@]}" "${node_ts[@]}" "$here/src/main.ts" \
  --affine-server "$server" \
  --database-url "${AFFINE_DATABASE_URL:-postgresql://affine@localhost:5547/affine}" \
  --storage "${AFFINE_BLOB_STORAGE:-$selfhost/data/storage/blobs}" \
  --out "$out" "${backup_manifest[@]}" "${args[@]}"
