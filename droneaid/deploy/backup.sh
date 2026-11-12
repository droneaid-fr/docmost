#!/usr/bin/env bash
# Nightly backup of the Docmost stack at /opt/docmost. Port of affine-oci/affine/deploy/backup.sh.
#
# Installed on the VM as /opt/docmost/backup.sh, run from root's crontab:
#   45 2 * * * /opt/docmost/backup.sh >> /opt/docmost/backups/backup.log 2>&1
#
# What it saves, into $BACKUP_ROOT/<UTC timestamp>/:
#   docmost.dump    pg_dump -Fc of the database, taken from the running postgres
#                   container. pg_dump reads one consistent MVCC snapshot, so it is
#                   safe while Docmost is serving traffic.
#   storage.tar.gz  data/storage (attachments, images, avatars)
#   config.tar.gz   docmost.env and .env. docmost.env holds APP_SECRET, which keys the
#                   encryption of stored integration tokens (EncryptionService) and signs
#                   every session; a restore with a new secret signs everyone out and
#                   leaves those tokens undecryptable. It also holds the SMTP, Google and
#                   Gemini secrets, so the backup directory is root-only.
#   MANIFEST        row counts, latest migration, storage file count/size, sha256 of every file
#
# Not saved, on purpose:
#   data/redis      BullMQ queues and collaboration fan-out. Sessions live in Postgres;
#                   the translation sweep re-queues due pages on its own.
#
# The row counts in MANIFEST come from the very snapshot pg_dump uses
# (pg_export_snapshot + pg_dump --snapshot), so they match a restore exactly even
# while users are editing.
#
# Fails loudly: any error exits non-zero with an "ERROR" line on stderr, and the
# half-written directory is left as <timestamp>.partial (never counted as a backup,
# removed by the next successful run). Old backups are pruned only after a new one
# has fully succeeded.
#
# Every path and name can be overridden through the environment (used to test the
# script against droneaid/local/compose.yml); the defaults are the VM's.
set -Eeuo pipefail

DOCMOST_DIR=${DOCMOST_DIR:-/opt/docmost}
BACKUP_ROOT=${BACKUP_ROOT:-$DOCMOST_DIR/backups}
PG_CONTAINER=${PG_CONTAINER:-docmost_postgres}
PG_USER=${PG_USER:-docmost}
PG_DB=${PG_DB:-docmost}
# A host directory, or the name of a docker volume (tarred through a throwaway
# container of the postgres image, which is already on the host).
STORAGE_SRC=${STORAGE_SRC:-$DOCMOST_DIR/data/storage}
# Files that go into config.tar.gz, relative to DOCMOST_DIR. Missing ones are an error.
CONFIG_FILES=${CONFIG_FILES:-"docmost.env .env"}
IMAGE_FILE=${IMAGE_FILE:-$DOCMOST_DIR/.env}
REQUIRE_ROOT=${REQUIRE_ROOT:-1}
KEEP=${KEEP:-7}
# Refuse to run with less free space than this on the backup filesystem.
MIN_FREE_KB=${MIN_FREE_KB:-$((5 * 1024 * 1024))}
KEY_TABLES=(workspaces users groups group_users spaces space_members pages
  page_history attachments comments shares backlinks auth_accounts auth_providers
  user_sessions droneaid_agents droneaid_agent_tokens droneaid_user_mcp_tokens
  droneaid_signup_rules droneaid_page_translations droneaid_import_map kysely_migration)

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }
trap 'log "ERROR: backup failed at line $LINENO: $BASH_COMMAND" >&2' ERR

if [[ $REQUIRE_ROOT == 1 ]]; then [[ $EUID -eq 0 ]] || die "must run as root"; fi
command -v docker >/dev/null || die "docker not found"
[[ $KEEP =~ ^[1-9][0-9]*$ ]] || die "KEEP must be a positive integer"

mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"

exec 9>"$BACKUP_ROOT/.lock"
flock -n 9 || die "another backup is running"

free_kb=$(df --output=avail -k "$BACKUP_ROOT" | tail -1 | tr -d ' ')
((free_kb >= MIN_FREE_KB)) ||
  die "only $((free_kb / 1024)) MB free on $BACKUP_ROOT, need $((MIN_FREE_KB / 1024)) MB"

docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null ||
  die "postgres container $PG_CONTAINER is not ready"
for f in $CONFIG_FILES; do
  [[ -f $DOCMOST_DIR/$f ]] || die "config file $DOCMOST_DIR/$f not found"
done

ts=$(date -u +%Y%m%dT%H%M%SZ)
dest="$BACKUP_ROOT/$ts"
work="$dest.partial"
mkdir "$work"
chmod 700 "$work"
start=$(date +%s)
log "backup $ts started ($((free_kb / 1024)) MB free)"

# --- Postgres: hold a REPEATABLE READ transaction, export its snapshot, count rows in
# it and let pg_dump read the same snapshot.
coproc PSQL { docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" \
  -Atq -v ON_ERROR_STOP=1; }
# shellcheck disable=SC2153 # PSQL_PID is set by coproc
psql_pid=$PSQL_PID
psql_in=${PSQL[1]}
psql_out=${PSQL[0]}
echo "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();" >&"$psql_in"
read -r -t 30 snapshot <&"$psql_out" || die "could not export a snapshot"
[[ $snapshot =~ ^[0-9A-F-]+$ ]] || die "unexpected snapshot id: $snapshot"

counts_sql=""
for t in "${KEY_TABLES[@]}"; do
  counts_sql+="${counts_sql:+ UNION ALL }SELECT '$t', count(*) FROM $t"
done
echo "$counts_sql;" >&"$psql_in"
row_counts=()
for _ in "${KEY_TABLES[@]}"; do
  read -r -t 60 line <&"$psql_out" || die "row count query failed"
  row_counts+=("$line")
done
# The newest migration tells which image can open this dump: an image that lacks
# it refuses to boot (Kysely: "previously executed migration ... is missing").
echo "SELECT coalesce(max(name), 'none') FROM kysely_migration;" >&"$psql_in"
read -r -t 30 latest_migration <&"$psql_out" || die "migration query failed"

docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc \
  --snapshot="$snapshot" >"$work/docmost.dump"

echo "COMMIT;" >&"$psql_in"
exec {psql_in}>&-
wait "$psql_pid" || die "snapshot session exited non-zero"

# Sanity: the archive must be readable and contain the tables we counted.
toc=$(docker exec -i "$PG_CONTAINER" pg_restore --list <"$work/docmost.dump")
for t in "${KEY_TABLES[@]}"; do
  grep -qE "TABLE DATA public $t " <<<"$toc" || die "dump has no data for table $t"
done

# --- Files
if [[ $STORAGE_SRC == /* ]]; then
  [[ -d $STORAGE_SRC ]] || die "storage directory $STORAGE_SRC not found"
  tar -C "$(dirname "$STORAGE_SRC")" -czf "$work/storage.tar.gz" "$(basename "$STORAGE_SRC")"
else
  docker volume inspect "$STORAGE_SRC" >/dev/null 2>&1 || die "docker volume $STORAGE_SRC not found"
  pg_image=$(docker inspect -f '{{.Config.Image}}' "$PG_CONTAINER")
  docker run --rm --network none -v "$STORAGE_SRC:/backup/storage:ro" \
    --entrypoint tar "$pg_image" -C /backup -czf - storage >"$work/storage.tar.gz"
fi
# shellcheck disable=SC2086 # CONFIG_FILES is a space-separated list
tar -C "$DOCMOST_DIR" -czf "$work/config.tar.gz" $CONFIG_FILES

# Count what actually went into the archive, not what is on disk a moment later.
read -r storage_files storage_bytes < <(tar -tvzf "$work/storage.tar.gz" |
  awk '/^-/ { n++; s += $3 } END { print n + 0, s + 0 }')

# --- Manifest
{
  echo "timestamp: $ts"
  echo "host: $(hostname)"
  echo "image: $(grep -oP '^DOCMOST_IMAGE=\K.*' "$IMAGE_FILE" 2>/dev/null || echo unknown)"
  echo "postgres: $(docker exec "$PG_CONTAINER" postgres --version)"
  echo "pg_snapshot: $snapshot"
  echo "latest_migration: $latest_migration"
  echo
  echo "[row_counts]"
  for line in "${row_counts[@]}"; do
    printf '%s %s\n' "${line%%|*}" "${line#*|}"
  done
  echo
  echo "[storage]"
  echo "files $storage_files"
  echo "bytes $storage_bytes"
  echo
  echo "[sha256]"
  (cd "$work" && sha256sum docmost.dump storage.tar.gz config.tar.gz)
} >"$work/MANIFEST"

(cd "$work" && sha256sum --quiet -c <(sed -n '/^\[sha256\]/,$p' MANIFEST | tail -n +2)) ||
  die "checksum self-check failed"

chmod 600 "$work"/*
mv "$work" "$dest"

# --- Retention: keep the newest $KEEP complete backups; drop stale partials.
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '*.partial' -exec rm -rf {} +
mapfile -t old < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d \
  -regextype posix-extended -regex '.*/[0-9]{8}T[0-9]{6}Z' -printf '%f\n' |
  sort -r | tail -n +$((KEEP + 1)))
for d in "${old[@]}"; do
  rm -rf "${BACKUP_ROOT:?}/$d"
  log "pruned $d"
done

size=$(du -sh "$dest" | cut -f1)
log "backup $ts ok: $size in $(($(date +%s) - start)) s, $storage_files storage files"
