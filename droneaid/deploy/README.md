# Production deploy runbook (Oracle VM)

Docmost replaced AFFiNE on the same Oracle VM (Ubuntu 24.04 arm64, 2 OCPU / 12 GB,
`130.61.175.219`) on 2026-11-11; **AFFiNE was removed from the VM the same day** (see
"AFFiNE removal" below). **No side-by-side staging:** AFFiNE is frozen and stopped first, then
Docmost is set up and takes over `base.droneaid.fr` in one downtime window. The data move
itself is [`../migration/RUNBOOK.md`](../migration/RUNBOOK.md); this file covers the stack,
Caddy, the pipeline, rollback and backups. Short checklist: `base/.notes/docmost-deploy-next-steps.md`.

| File | Goes to | Purpose |
|---|---|---|
| `.github/workflows/droneaid-deploy.yml` | (CI) | build `ghcr.io/droneaid-fr/docmost:stable-<sha9>` (arm64) and roll it out |
| `rollout.sh` | piped over ssh, never copied | deploy / rollback / restore-predeploy on the VM |
| `compose.yml` | `/opt/docmost/compose.yml` | docmost + postgres:18 + redis:8 |
| `docmost.env.example` | `/opt/docmost/docmost.env` | every env var production reads (no values) |
| `backup.sh` | `/opt/docmost/backup.sh` | nightly online backup |
| `Caddyfile.snippet` | part 2 → `/opt/caddy/conf/Caddyfile` | production Caddyfile (part 1, a staging block, is unused) |
| `caddy/compose.yml` | `/opt/caddy/compose.yml` | standalone Caddy from the cutover on |
| `gen-redirects.mjs` | (operator machine) | `url-map.json` → `redirects.caddy` |

## Layout on the VM

```
/opt/docmost/                     owner ubuntu (the deploy user)
  compose.yml
  docmost.env                     app config + secrets, ubuntu:ubuntu 600
  .env                            DOCMOST_IMAGE=... (written only by the workflow)
  .env.previous / .env.failed     image before the last rollout / image that failed
  predeploy/                      pg_dump taken before each rollout (newest 5) + migration list
  data/storage/                   attachments (uid 1000: the image runs as `node`)
  data/postgres/                  postgres 18 (PGDATA in 18/docker)
  data/redis/                     appendonly file
  backup.sh, backups/             root, 700
/opt/caddy/                       standalone Caddy; volumes caddy_data, caddy_config (external)
```

```
Internet → Caddy :80/:443 ──(docker network "edge")──→ docmost:3000
                                                         ├→ db (postgres 18)   project network only
                                                         └→ redis 8            project network only
```

**Why a shared `edge` network.** Caddy today is the `caddy` service of the AFFiNE
compose project, on its default network `affine_default`; it reaches `affine:3010` by
service name. Joining Docmost to `affine_default` would tie Docmost to a network that
disappears with AFFiNE. Instead, one external network `edge` belongs to neither project:
Docmost's app joins it in `compose.yml`, Caddy joins it (first in the AFFiNE compose, at
cutover in its own `/opt/caddy` project). AFFiNE can then be stopped and removed without
touching the front door, and postgres/redis never sit on a network Caddy sees.

**Memory.** Limits: docmost 2 GB, postgres 1 GB, redis 512 MB (the local stack idles at
~40 MB for postgres and ~10 MB for redis). AFFiNE is gone, so the VM has ample room.

## Before the downtime (outside the VM)

1. Google OAuth client: add `https://base.droneaid.fr/api/droneaid/auth/google/callback`
   (test with a junk control URI, `affine-oci/affine/state.md` "Domain flip").
2. GitHub, repo `droneaid-fr/docmost`: environment `production` (restrict deployment
   branches to `production`), its secrets `ORACLE_HOST`, `ORACLE_USER`,
   `ORACLE_SSH_KEY`, `ORACLE_SSH_KNOWN_HOSTS` (same values as the AFFiNE fork), and the
   variable `DEPLOY_URL=https://base.droneaid.fr`.
3. Secrets for `docmost.env` ready: fresh `APP_SECRET` and `POSTGRES_PASSWORD`, Resend
   key, Google client, Gemini key.

## Cutover (one downtime window)

1. **Freeze and export AFFiNE**: migration RUNBOOK steps 1-2 (stop the `affine`
   container, final backup, export the bundle locally).
2. **Move Caddy out of the AFFiNE project**, so stopping AFFiNE keeps the front door up:
   ```bash
   docker network create edge
   docker volume create caddy_data && docker volume create caddy_config  # fresh VM only*
   sudo mkdir -p /opt/caddy/conf && sudo chown -R ubuntu:ubuntu /opt/caddy
   # /opt/caddy/compose.yml          <- droneaid/deploy/caddy/compose.yml
   # /opt/caddy/conf/Caddyfile       <- PART 2 of Caddyfile.snippet
   # /opt/caddy/conf/redirects.caddy <- placeholder until the import: printf '(droneaid_redirects) {\n}\n'
   docker run --rm -v /opt/caddy/conf:/etc/caddy:ro caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile
   # In /opt/affine/compose.yml delete the `caddy` service (keep the top-level
   # caddy_data/caddy_config volumes: /opt/caddy reuses them as external volumes, so the
   # certificates and ACME account carry over). Back up compose.yml first. Then, back
   # to back. Do NOT use `docker compose up -d --remove-orphans` here: it would start
   # the frozen `affine` server again.
   docker rm -f affine_caddy
   cd /opt/caddy  && docker compose up -d
   cd /opt/affine && docker compose stop                      # AFFiNE stopped, restorable
   ```
   Also disable the AFFiNE fork's deploy workflow, so a push there cannot restart AFFiNE.
   Until Docmost is up, `base.droneaid.fr` answers 502.
   \*At the 2026-11-11 cutover `/opt/caddy` first reused AFFiNE's `affine_caddy_*`
   volumes; they were copied to `caddy_data` / `caddy_config` when AFFiNE was removed.
3. **Set up `/opt/docmost`:**
   ```bash
   sudo mkdir -p /opt/docmost/data/{storage,postgres,redis}
   sudo chown ubuntu:ubuntu /opt/docmost && sudo chown 1000:1000 /opt/docmost/data/storage
   # from the operator machine, repo root:
   scp droneaid/deploy/{compose.yml,backup.sh} ubuntu@VM:/opt/docmost/
   scp droneaid/deploy/docmost.env.example ubuntu@VM:/opt/docmost/docmost.env
   #   fill docmost.env (APP_URL=https://base.droneaid.fr, secrets); chmod 600
   sudo chown root:root /opt/docmost/backup.sh && sudo chmod 700 /opt/docmost/backup.sh
   ```
4. **Deploy**: `git push origin droneaid:production`. The first rollout has no
   `.env.previous`; migrations run on first boot.
5. **Import** into the empty database (no UI setup before it): migration RUNBOOK step 3,
   then step 4: copy `migration/import-<ts>/redirects.caddy` to
   `/opt/caddy/conf/redirects.caddy` and `docker exec caddy caddy reload --config /etc/caddy/Caddyfile`.
6. **Admin, agent, checks**: migration RUNBOOK steps 5-6.
7. **Backups**: `sudo crontab -e` →
   `45 2 * * * /opt/docmost/backup.sh >> /opt/docmost/backups/backup.log 2>&1`,
   then run it once by hand.

**Back to AFFiNE** is no longer possible on the VM: AFFiNE was removed on 2026-11-11.
Its final backup (`affine-20261111T170033Z`) is kept off the VM, in `base/backups/`.

## Deploying

- `droneaid` is the integration branch; **a push to `production` deploys**
  (`git push origin droneaid:production`). `workflow_dispatch` builds any ref
  (build-only by default; `deploy: true` also rolls out).
- Build: native `ubuntu-24.04-arm` runner, plain `Dockerfile`, buildx with the GHA cache,
  pushed with the job's `GITHUB_TOKEN`.
- Rollout (`rollout.sh deploy`): pre-deploy `pg_dump` + list of executed migrations →
  `.env` → `.env.previous`, new `.env` → `docker compose pull` (failure: `.env` restored,
  nothing changed) → `up -d` (bounded, 600 s) → wait for the container healthcheck
  (`/api/health`, 300 s) → the workflow then checks `${DEPLOY_URL}/api/health` publicly
  (5 min). Any failure triggers `rollback`.
- Source offer (AGPL §13): before rolling out, the deploy job refuses a commit that is not
  on `production` or `droneaid` of the public repo; after the public health check it tags
  the commit `deploy/<YYYYMMDD>-<sha7>`. Never delete those tags.

## Rollback and migrations

Docmost runs its Kysely migrations on every boot, and **an image refuses to boot when the
database holds a migration it does not ship** (`corrupted migrations: previously executed
migration X is missing`; checked locally: `:local` on a schema migrated by `:s9`
crash-loops). So rollback is image-only and its safety depends on the migrations:

| Case | What `rollback` does |
|---|---|
| New image added no migration, or its migration failed (Kysely runs them in one transaction, so nothing is left behind) | Restores `.env.previous`, `up -d`, waits for healthy. Automatic. |
| New image applied a migration | **Refuses** and leaves the new image running (the old one would crash-loop). The job fails with the list of new migrations. |

In the second case, choose by hand:
- **Fix forward** (preferred): push a fixed commit to `production`.
- **Restore the pre-deploy dump**, losing every write since the rollout started:
  `CONFIRM=yes bash rollout.sh restore-predeploy` on the VM (copy the script from the repo,
  it is not kept there). It stops the app, recreates the database from the newest
  `predeploy/*.dump`, starts `.env.previous`'s image and waits for healthy. Storage is not
  touched (migrations do not change files; files uploaded since then stay as orphans).

No down-migration runs automatically. Manual image switch: edit `.env`, `docker compose up -d`.

## Backups and restore

`backup.sh` (root, nightly) writes `/opt/docmost/backups/<UTC ts>/`:
`docmost.dump` (`pg_dump -Fc` via `docker exec docmost_postgres`, online), `storage.tar.gz`,
`config.tar.gz` (`docmost.env` and `.env`) and `MANIFEST` (row counts of 22 key tables from
the same snapshot as the dump, the newest migration, storage file count/bytes, sha256).
Writes into `<ts>.partial` and renames on success, refuses below 5 GB free, keeps the newest
7, exits non-zero with an `ERROR` line on failure. Redis is not saved (queues only; sessions
are in Postgres).

**Why `docmost.env` is in the backup.** `APP_SECRET` signs every session and share/attachment
token and keys `EncryptionService`, which encrypts stored integration tokens
(`integrations/encryption`). Restoring with a different secret signs everybody out and leaves
those rows undecryptable. Agent and personal MCP tokens are unkeyed sha256 hashes and survive
a new secret. The file also holds the SMTP, Google and Gemini secrets, so the backup directory
is root-only, and any off-site copy must be encrypted. (Off-site copies are still open.)

Verified 2026-11-10 against `droneaid/local` (env overrides: `PG_CONTAINER=docmost-local-db-1`,
`STORAGE_SRC=docmost-local_docmost_storage`, `REQUIRE_ROOT=0`): 23 MB in 1 s; restored into a
scratch `postgres:18`, all 22 MANIFEST counts equal, 97 storage files / 21,995,876 bytes equal,
sha256 OK; low disk, missing container, missing config, non-root and mid-run failures exit 1
with `ERROR` and leave `.partial`; retention prunes beyond `KEEP`.

Restore (into the same or a fresh `/opt/docmost`):

```bash
B=/opt/docmost/backups/<ts>; cd /opt/docmost
grep -E '^(image|latest_migration):' $B/MANIFEST   # the image must ship latest_migration
tar -xzf $B/config.tar.gz -C /opt/docmost            # docmost.env + .env (only if lost)
docker compose up -d db redis && docker compose stop docmost
docker exec docmost_postgres dropdb -U docmost --force --if-exists docmost
docker exec docmost_postgres createdb -U docmost -O docmost docmost
docker exec -i docmost_postgres pg_restore -U docmost -d docmost --no-owner --exit-on-error < $B/docmost.dump
rm -rf data/storage && tar -C data -xzf $B/storage.tar.gz && chown -R 1000:1000 data/storage
docker compose up -d
```

Then compare a few MANIFEST counts (`select count(*) from pages`, ...).

## AFFiNE removal (done 2026-11-11)

1. Checked that the VM's final AFFiNE backup `/opt/affine/backups/20261111T170033Z` was
   byte-identical (sha256) to the local copy `base/backups/affine-20261111T170033Z`, and
   saved `/opt/affine` without data and backups to `base/backups/affine-vm-opt-config-20261111.tar.gz`.
2. Moved Caddy off AFFiNE's volumes: `docker volume create caddy_data caddy_config`,
   stopped Caddy, `cp -a` each old volume into the new one with a throwaway `alpine`
   container (10 and 1 files), pointed `/opt/caddy/compose.yml` at the new names
   (old file kept as `compose.yml.bak-pre-volmove-20261111`), `up -d --force-recreate`.
   Both certificates kept their serials; Caddy made no ACME request.
3. `docker compose down` in `/opt/affine`; removed its containers (also the old
   `affine_migration_job`), the `affine_default` network, the `affine_caddy_*` volumes,
   every AFFiNE, pgvector, manticore and `redis:latest` image, root's 02:30 AFFiNE
   backup cron line, then `/opt/affine` itself (data and the VM's AFFiNE backups).
   Disk use went from 53 % to 14 %.
4. Checked: `/api/health` 200, `base.drone-aid.fr` 301, old AFFiNE links redirect, MCP
   answers 401 without a token, `caddy validate` OK.
