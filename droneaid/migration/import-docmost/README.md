# import-docmost — migration bundle → Docmost (S6b)

Reads the bundle written by [`../export-affine`](../export-affine/README.md) and
recreates it in Docmost: users, spaces and members, the page tree, page
content with attachments and databases, the trash, shares, translations,
comments, signup rules and the DA France agent. It also writes the old-URL map
and a Caddy redirect snippet. The cutover procedure is in
[`../RUNBOOK.md`](../RUNBOOK.md).

## How it runs

The importer is server code (`apps/server/src/droneaid/migration/`), built with
the server and started as a one-shot Nest app
(`apps/server/dist/droneaid/migration/import-cli.js`). It boots the whole
server module graph without listening, so every write goes through core
services and repositories, as Docmost's own import does:

| Object | Written with |
|---|---|
| workspace (empty Docmost) | `SignupService.initialSetup` |
| users | `SignupService.signup` (joins the workspace and "Everyone"), then role, avatar URL, dates; random unusable password as for Google signup (S2a) |
| spaces, members | `SpaceService.createSpace` (creator = AFFiNE owner), `SpaceMemberService.addUserToSpace` |
| agent | `AgentService.createAgent` with the new `spaceId` option (no token) |
| pages | `PageRepo.insertPage` with `content`, `ydoc` (`ImportService.createYdoc`) and `text_content`, exactly like core's ZIP import; trash via `PageRepo.removePage` |
| files | `AttachmentService.uploadToDrive` + `saveAttachment` (storage driver + `attachments` row) |
| Markdown → ProseMirror | S3b `markdownToDoc` (core `markdownToHtml` + `htmlToJson`, links → mentions/internal links, `blob://` → file) |
| databases | S4a `databaseToJson` at the marker position, ids kept |
| shares | `ShareService.createShare` |
| translations | row in `droneaid_page_translations`, `status=ready`, `source_hash` = S5 `sourceHash` of the imported page, `source_updated_at` = page `updated_at` |
| comments | `CommentRepo.insertComment` (no notification mails) |
| backlinks | `BacklinkRepo.insertBacklink` |
| signup rules | `SignupRulesService.saveRules` (Google signup switched on) |

All page ids are allocated before any content is written, so `affine://`
links resolve to pages created later in the same run (two passes: plan, then
write).

**Idempotent per bundle.** Every created object is recorded in
`droneaid_import_map` (migration `20261111T090000-droneaid-import-map`). A
re-run with the same bundle skips what exists and creates what is missing (a
crashed run resumes). A different bundle is refused: import it into an empty
Docmost.

## Mapping

- **Spaces**: one per AFFiNE workspace, same name, except the workspaces left
  out with `--exclude-workspaces` (default `Demo Workspace`, a local-only test
  workspace whose only member was mark.p): no space, pages, files or
  import-map rows; its old URLs are dropped from the URL map and fall through
  to `/home`. The report's *Workspaces not migrated* section counts what was
  dropped; the verifier checks against the bundle without it. Folders become empty folder
  pages; docs in a folder become their children; docs in no folder go to the
  top level after the folders, oldest first. Sibling order follows the AFFiNE
  sidebar (`index`). A doc in several folders goes under the first (reported).
- **Users**: the 15 humans; `--owner-email` → workspace owner, AFFiNE admins →
  admin, others member. Agents and unused placeholders are skipped (reported).
- **Space roles**: AFFiNE owner/admin → admin, member → writer, external →
  reader. "Everyone" gets no access to migrated spaces.
- **General**: Docmost's setup creates an empty "General" space (Everyone =
  writer) as `workspaces.default_space_id`. The importer deletes it with core's
  `SpaceService.deleteSpace` right after setup and sets the reference to null
  (only an empty, unmapped space with slug `general`; otherwise it warns and
  keeps it). Core never reads `default_space_id`; new members get spaces from
  their signup rule or invitation groups only. Per-doc grants are not reproduced; the report lists those
  that widened or narrowed access.
- **Agent**: `DroneAid France agent`, writer in DroneAid France, reader where
  it held AFFiNE grants in other workspaces (none in the current data).
- **Content**: colour spans → Docmost text colours; LaTeX → math nodes (a
  maths block inside a list is kept in its list item); images and the
  attachment → files of their page; bookmarks / synced docs → links; YouTube
  → embed; canvas-only drawings dropped, canvas text appended under
  "Canvas notes". A trailing empty paragraph is added where the editor would
  add one on first open, so opening a page does not change it.
- **Trash**: trashed docs are imported and moved to the Docmost trash
  (`--skip-trashed` to leave them out). Docmost purges trash after 30 days.

## Run

```bash
pnpm editor-ext:build && (cd apps/server && npx nest build)
./run.sh import --bundle <bundle-dir> [--out <dir>] [--verify]
./run.sh verify --bundle <bundle-dir> [--out <dir>]
./run.sh reset-local --yes      # local dev only: empty DB + storage, migrate
./run.sh test                   # unit tests
```

CLI flags: `--owner-email` (default `filipp@droneaid.fr`), `--workspace-name`
(`DroneAid`, used only when Docmost is empty), `--agent-name`
(`DroneAid France agent`), `--agent-workspace` (`DroneAid France`),
`--no-agent`, `--skip-trashed`, `--exclude-workspaces "<name or id>,..."`
(default `Demo Workspace`; `none` imports all), `--verify` / `--verify-only`.

The CLI reads the root `.env` (or the container environment) like the server
and must run with `apps/server` as working directory (local storage resolves
to `<repo>/data/storage`, `/app/data/storage` in the image).

## Output (`--out`, mode 700; default `<bundle>/../import-docmost-<ts>/`)

| File | Content |
|---|---|
| `import-report.md` / `.json` | what was created or skipped; grants to review, skipped users and memberships, multi-folder docs, databases, dropped formatting, unresolved links, trash, comments, signup rules, blobs not imported, warnings |
| `url-map.json` | `mapped` (old path → new path) and `unmapped` with reasons; `fallback: /home` |
| `redirects.caddy` | Caddy snippet `(droneaid_redirects)` |
| `verify.md` / `.json` | `--verify`: counts against the bundle, every database cell compared, translations current, `affine://` left, fingerprint |

The outputs contain titles and ids: keep them with the bundle, never commit them.

## Old URLs

`/workspace/<ws>/<doc>` → the page (the public share for published docs, which
AFFiNE served on the same path); `/share/<ws>/<doc>` → the share or page;
`/workspace/<ws>[/all|journals|trash|tag/…|collection/…|settings]` → the space;
`/api/workspaces/<ws>/blobs/<key>` → the file (first page using it);
`/invite/<id>` → `/login`. The query string is kept (`?lang=` works on shares).
Every other old path (`/workspace/*`, `/share/<ws uuid>/*`, old blob API) goes
to `/home`. Docmost's own `/share/<key>/p/<slug>` paths are never matched.
