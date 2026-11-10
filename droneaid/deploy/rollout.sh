#!/usr/bin/env bash
# Rolls the Docmost stack at /opt/docmost to a new image, or back. Runs ON the VM.
#
# The deploy workflow (.github/workflows/droneaid-deploy.yml) pipes this file over ssh
# (`bash -s -- <command>`); nothing is copied to the VM. An operator can run the same
# file by hand: `sudo -u ubuntu bash rollout.sh rollback`.
#
#   deploy <image>       pre-deploy dump, write .env (keep .env.previous), pull, up, wait
#                        for the container's healthcheck; on failure run `rollback`
#   rollback             back to the image in .env.previous, IF the schema still fits it
#   restore-predeploy    manual only (CONFIRM=yes): restore the newest pre-deploy dump and
#                        start the previous image
#
# Why rollback checks migrations: Docmost runs its Kysely migrations on boot, and Kysely
# refuses to start when the database holds an executed migration the image does not ship
# ("corrupted migrations: previously executed migration X is missing"). So once a new
# image has applied a migration, the previous image can no longer boot, and an image-only
# rollback would turn a broken site into a crash loop. Rollback therefore compares the
# executed migrations with the list recorded before the rollout:
#   - unchanged (the release had no migration, or it failed and its transaction rolled
#     back): image-only rollback, automatic;
#   - changed: leave the new image running, exit non-zero and print the manual choices
#     (fix forward, or `restore-predeploy`, which loses writes made since the dump).
# No down-migration ever runs automatically.
#
# Registry credentials come in as REGISTRY_USER / REGISTRY_TOKEN (the workflow's
# job-scoped GITHUB_TOKEN); they are only needed when the package is private.
set -Eeuo pipefail

DOCMOST_DIR=${DOCMOST_DIR:-/opt/docmost}
PREDEPLOY_DIR=$DOCMOST_DIR/predeploy
PREDEPLOY_KEEP=5
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-300}
# Tests against droneaid/local images override this; the workflow never does.
IMAGE_PATTERN=${IMAGE_PATTERN:-'^ghcr\.io/droneaid-fr/docmost:stable-[0-9a-f]{7,40}$'}
APP_CONTAINER=docmost
PG_CONTAINER=docmost_postgres

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

cd "$DOCMOST_DIR" || die "$DOCMOST_DIR not found"
[[ -f compose.yml && -f docmost.env ]] || die "compose.yml or docmost.env missing in $DOCMOST_DIR"

pg_env() { grep -oP "^$1=\K.*" docmost.env; }
PG_USER=$(pg_env POSTGRES_USER)
PG_DB=$(pg_env POSTGRES_DB)
psql_q() { docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -Atq -v ON_ERROR_STOP=1 -c "$1"; }
db_running() { docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; }
# Empty output when the migrations table does not exist yet (first deploy).
executed_migrations() {
  { psql_q "SELECT name FROM kysely_migration" 2>/dev/null || true; } | LC_ALL=C sort
}
current_image() { grep -oP '^DOCMOST_IMAGE=\K.*' .env 2>/dev/null || true; }

wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) status
  while ((SECONDS < deadline)); do
    status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
      "$APP_CONTAINER" 2>/dev/null || echo missing)
    [[ $status == healthy ]] && { log "$APP_CONTAINER is healthy"; return 0; }
    sleep 5
  done
  log "ERROR: $APP_CONTAINER not healthy after ${HEALTH_TIMEOUT}s (last status: ${status:-unknown})" >&2
  docker compose ps >&2 || true
  docker compose logs --tail=80 docmost >&2 || true
  return 1
}

compose_up() { timeout 600 docker compose up -d --remove-orphans; }

registry_login() {
  if [[ -n ${REGISTRY_TOKEN:-} ]]; then
    printf '%s' "$REGISTRY_TOKEN" | docker login ghcr.io -u "${REGISTRY_USER:?}" --password-stdin >/dev/null
    trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
  fi
}

predeploy_dump() {
  mkdir -p "$PREDEPLOY_DIR"
  chmod 700 "$PREDEPLOY_DIR"
  if ! db_running; then
    log "no running database: first deploy, nothing to dump"
    : >"$PREDEPLOY_DIR/latest.migrations"
    return 0
  fi
  local ts
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc >"$PREDEPLOY_DIR/$ts.dump.partial"
  mv "$PREDEPLOY_DIR/$ts.dump.partial" "$PREDEPLOY_DIR/$ts.dump"
  executed_migrations >"$PREDEPLOY_DIR/$ts.migrations"
  printf '%s\n' "$(current_image)" >"$PREDEPLOY_DIR/$ts.image"
  cp "$PREDEPLOY_DIR/$ts.migrations" "$PREDEPLOY_DIR/latest.migrations"
  chmod 600 "$PREDEPLOY_DIR/$ts".*
  log "pre-deploy dump $ts.dump ($(du -h "$PREDEPLOY_DIR/$ts.dump" | cut -f1)), $(wc -l <"$PREDEPLOY_DIR/$ts.migrations") migrations"
  # Keep the newest $PREDEPLOY_KEEP dumps (and their sidecar files).
  local old
  while read -r old; do
    rm -f "$PREDEPLOY_DIR/${old%.dump}".{dump,migrations,image}
  done < <(find "$PREDEPLOY_DIR" -maxdepth 1 -name '*.dump' -printf '%f\n' | sort -r | tail -n +$((PREDEPLOY_KEEP + 1)))
}

cmd_rollback() {
  [[ -f .env.previous ]] || die "no .env.previous: nothing to roll back to"
  local new_migrations
  new_migrations=$(LC_ALL=C comm -13 "$PREDEPLOY_DIR/latest.migrations" <(executed_migrations) || true)
  if [[ -n $new_migrations ]]; then
    log "ERROR: the new image applied migrations the previous image does not know:" >&2
    # shellcheck disable=SC2001
    sed 's/^/  /' <<<"$new_migrations" >&2
    log "ERROR: the previous image would refuse to boot, so the new one stays up. Either fix" >&2
    log "ERROR: forward (push a fix to production), or restore the pre-deploy dump, losing" >&2
    log "ERROR: writes made since the rollout: CONFIRM=yes bash rollout.sh restore-predeploy" >&2
    return 1
  fi
  cp .env .env.failed 2>/dev/null || true
  cp .env.previous .env
  log "rolling back to $(current_image)"
  compose_up || die "compose up of the previous image failed"
  wait_healthy || die "previous image is not healthy either"
  log "rolled back to $(current_image)"
}

cmd_deploy() {
  local image=${1:?usage: deploy <image>}
  [[ $image =~ $IMAGE_PATTERN ]] || die "unexpected image: $image"
  registry_login
  predeploy_dump
  if [[ -f .env ]]; then cp .env .env.previous; fi
  printf 'DOCMOST_IMAGE=%s\n' "$image" >.env
  log "deploying $image (previous: $(grep -oP '^DOCMOST_IMAGE=\K.*' .env.previous 2>/dev/null || echo none))"
  # SKIP_PULL=1 only for tests with locally built images.
  if [[ ${SKIP_PULL:-0} != 1 ]] && ! docker compose pull; then
    if [[ -f .env.previous ]]; then cp .env.previous .env; else rm -f .env; fi
    die "pull of $image failed; nothing changed"
  fi
  if compose_up && wait_healthy; then
    docker image prune -f --filter 'until=168h' >/dev/null || true
    log "deployed $image"
    return 0
  fi
  log "ERROR: rollout of $image failed, rolling back" >&2
  cmd_rollback || true
  return 1
}

cmd_restore_predeploy() {
  [[ ${CONFIRM:-} == yes ]] || die "destroys the current database; run with CONFIRM=yes"
  [[ -f .env.previous ]] || die "no .env.previous"
  local dump
  dump=$(find "$PREDEPLOY_DIR" -maxdepth 1 -name '*.dump' -printf '%f\n' | sort -r | head -1)
  [[ -n $dump ]] || die "no pre-deploy dump in $PREDEPLOY_DIR"
  log "restoring $dump and starting $(grep -oP '^DOCMOST_IMAGE=\K.*' .env.previous)"
  docker compose stop docmost
  docker exec "$PG_CONTAINER" dropdb -U "$PG_USER" --force "$PG_DB"
  docker exec "$PG_CONTAINER" createdb -U "$PG_USER" -O "$PG_USER" "$PG_DB"
  docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$PG_DB" --no-owner --exit-on-error \
    <"$PREDEPLOY_DIR/$dump"
  cp .env .env.failed
  cp .env.previous .env
  compose_up || die "compose up failed"
  wait_healthy || die "not healthy after restore"
  log "restored $dump; running $(current_image)"
}

case ${1:-} in
  deploy) shift; cmd_deploy "$@" ;;
  rollback) cmd_rollback ;;
  restore-predeploy) cmd_restore_predeploy ;;
  *) die "usage: rollout.sh deploy <image> | rollback | restore-predeploy" ;;
esac
