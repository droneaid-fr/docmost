# AFFiNE → Docmost cutover runbook (migration tooling)

The exact sequence for moving production data with
[`export-affine`](export-affine/README.md) (S6a) and
[`import-docmost`](import-docmost/README.md) (S6b). Infrastructure (the
Docmost stack on the VM, Caddy, deploy pipeline) is Phase 7; this runbook
assumes it is staged and the Docmost database is **empty** (no workspace, no
setup done). Paths: `base/` is the migration workspace on the operator's
machine, `/opt/docmost` the stack on the VM.

Expected timings (dry run 2026-11-09, 92 docs / 184 blobs): export ~1 s,
import ~5 s, verify ~1 s. Plan a 30-minute freeze for the whole sequence.
Step 3 was rehearsed in S7 (2026-11-09) with the image, inside the app
container of `droneaid/local/compose.yml`: import 5 s, `--verify` PASS.

## 0. Before the day

- Docmost image built from `droneaid` (contains the importer and the
  `droneaid_import_map` migration); stack started once so migrations ran; no
  setup done (empty `workspaces` table).
- Google OAuth client has the Docmost callback URI
  `https://base.droneaid.fr/api/droneaid/auth/google/callback` (S2a).
- Local tools ready: restored-backup stack (`affine/affine-selfhost`), the
  exporter (`droneaid/migration/export-affine/run.sh test` passes).
- Announce the freeze.

## 1. Freeze AFFiNE and take the final backup

1. Stop edits: put AFFiNE in maintenance (stop the `affine` container; Caddy
   then answers 502 — acceptable for the freeze window) or announce
   read-only.
2. Run the nightly backup job by hand on the VM and copy it to
   `base/backups/affine-<ts>/` (Phase 0 procedure, `affine/affine-oci`).
3. Restore it into the local restored stack
   (`affine/affine-selfhost/restore-*`, Phase 0) and check its `MANIFEST`.

## 2. Export

```bash
cd base/docmost/droneaid/migration/export-affine
./run.sh --source-backup affine-<ts>      # -> base/backups/migration-bundle-<ts2>/
```

Exit 2 means a count check failed: stop and investigate (`report.md`). Read
`report.md` for new block flavours or losses since the dry run.

## 3. Import into the empty production Docmost

Copy the bundle to the VM (it is user data: mode 700, never commit it):

```bash
rsync -a --chmod=D700,F600 base/backups/migration-bundle-<ts2>/ \
  ubuntu@<vm>:/opt/docmost/migration/bundle/
```

Run the importer inside the running app container (same env, same storage),
with the bundle mounted or copied in, e.g. `docker cp`:

```bash
cd /opt/docmost
docker compose cp migration/bundle docmost:/tmp/bundle
docker compose exec -w /app/apps/server docmost \
  node dist/droneaid/migration/import-cli.js \
    --bundle /tmp/bundle --out /tmp/import --verify
docker compose cp docmost:/tmp/import migration/import-<ts2>
docker compose exec docmost rm -rf /tmp/bundle /tmp/import
```

- Exit 0 and **Result: PASS** in `verify.md`: continue.
- Exit 2 (a check failed) or 1 (an error): read the error / `verify.md`. The
  run is resumable: fix the cause and run the same command again; created
  objects are skipped. To start over instead, empty the database and storage
  (drop and recreate the DB, delete `data/storage`, restart the stack so
  migrations run) and import again.
- Do not import a different bundle on top of an import: it is refused.

Defaults used: owner `filipp@droneaid.fr`, workspace name `DroneAid`, agent
`DroneAid France agent` in space DroneAid France, trashed docs imported. All
users get an unusable random password; they sign in with Google, which links
by email.

## 4. Redirects

Copy `migration/import-<ts2>/redirects.caddy` next to the Caddyfile and use it
in the `base.droneaid.fr` site block, before the reverse proxy:

```caddyfile
import redirects.caddy            # top level: defines (droneaid_redirects)

base.droneaid.fr {
	import droneaid_redirects
	reverse_proxy docmost:3000
}
```

Keep the `base.drone-aid.fr` → `base.droneaid.fr` redirect and
`/oauth/hermes-luma.json` as they are. `caddy validate`, then reload. Spot
check: an old doc URL (301 to `/s/...`), a published doc with `?lang=fr` (301
to `/share/...?...lang=fr`), `/invite/x` (302 `/login`), an unknown
`/workspace/...` (302 `/home`). `url-map.json` lists the 119 unmapped paths
(unreferenced or canvas-only blobs); they fall back to `/home`.

## 5. Admin actions in Docmost (as filipp, signed in with Google)

1. **Mint the agent token**: Settings → Agents → *DroneAid France agent* →
   new token. Put it and the MCP URL `https://base.droneaid.fr/api/droneaid/mcp`
   into the Hermes profile (`config.yaml`), then apply the Phase 8 Hermes
   changes (`droneaid/hermes/SOUL.docmost.diff`, `pdf-import.patch`; replace
   the Guest list id with the new `Participant list` page id from
   `list_documents`).
2. **Review the grant list**: `import-report.md` → *Per-doc grants to review*.
   Today one entry: *Batteries* (DroneAid Academy) had members at `editor`
   instead of `manager`; in Docmost they get their space role. Decide whether
   any doc must move to a separate space.
3. **Check signup rules**: Settings → Signup rules shows `droneaid.fr`,
   `gey.olivier@gmail.com`, `yildirim.serhat62@gmail.com` → DroneAid France
   (writer) and `anton.chaika@drone-aid.pt` → DroneAid R&D (admin); Google
   signup on.
4. **Translations**: set `TRANSLATE_ENABLED=true` and `GEMINI_API_KEY`; the 3
   imported translations are served as they are and re-translated after the
   next edit.
5. **Trash**: 36 trashed AFFiNE docs are in the Docmost trash and are purged
   30 days after the import; restore any that must be kept.

## 6. Unfreeze and check

- Every user signs in with Google and sees their spaces.
- The agent completes a PDF import and a database edit (Phase 8 check).
- Old links redirect (step 4 spot check).
- Keep the AFFiNE stack stopped but restorable (Phase 9).

## Rollback

Until Caddy is switched (step 4), nothing user-facing changed: restart the
AFFiNE container and drop the Docmost database. After the switch, revert the
Caddyfile to the AFFiNE upstream and restart AFFiNE; edits made in Docmost in
between are lost unless copied by hand.
