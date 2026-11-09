# export-affine — AFFiNE → migration bundle (S6a)

Exports everything from the **restored** AFFiNE backup into a self-contained,
deterministic bundle that the S6b importer reads. Never run it against
production: it reads the restored Postgres (`affine-restore-pg`, `:5547`) and
the restored blob storage only, and it only issues `SELECT`s.

## How it reads AFFiNE

The exporter runs **inside the AFFiNE fork's runtime** (`base/affine/AFFiNE`,
commit recorded in the manifest) and imports the fork's own pure modules, the
same ones behind the MCP tools:

| Data | Fork code used | MCP tool it mirrors |
|---|---|---|
| Doc body | `core/utils/blocksuite.ts` `parseDocToMarkdownFromDocSnapshot` (native reader) + `preserve-blocks.ts` `blockSentinel` | `read_document` |
| Page links | `plugins/mcp/tools/references.ts` `renderReadReferences` | `read_document` |
| Databases | `database-model.ts` (`columnsOf`, `decodeCell`, ...), `database-edit.ts` (`readRows`, `describeColumns`), `database-markdown.ts` (`databaseMarker`) | `read_database` |
| Page meta, tags, collections, folders | `workspace-data.ts`, `core/doc/orm-table.ts` | `list_documents`, `list_tags`, `list_collections`, `list_folders` |

Snapshots come straight from Postgres (`snapshots.blob`; the run refuses if
`updates` holds unmerged rows). No AFFiNE server and no credential are needed
for the export. `spotcheck.py` then compares a bundle with the live MCP of the
restored server, using a human (non-agent) MCP credential, which sees every doc.

## Run

```bash
./run.sh --source-backup affine-20261108T213045Z          # -> base/backups/migration-bundle-<ts>/
./run.sh --source-backup affine-20261108T213045Z --out DIR
./run.sh test                                              # unit tests (node:test, in the fork runtime)
```

`run.sh` finds `base/` by walking up to the directory holding `affine/AFFiNE`
(override with `DRONEAID_BASE`), uses node 22 from nvm (`AFFINE_NODE_BIN`),
runs under `systemd-run --user --scope -p MemoryMax=6G -p MemorySwapMax=1G`
and refuses to start with < 8 GB available. Overrides: `AFFINE_DATABASE_URL`
(default `postgresql://affine@localhost:5547/affine`), `AFFINE_BLOB_STORAGE`
(default `affine/affine-selfhost/data/storage/blobs`). When
`base/backups/<source-backup>/MANIFEST` exists, its row counts are checked too.
The run writes `<out>.partial`, renames on success, and exits 2 if any count
check fails. A run takes about one second.

Spot-check (restored server running, see `affine/affine-selfhost/start-restored.sh`):

```bash
AFFINE_MCP_TOKENS='{"<ws>":"aff_mcp_v1.<id>.<secret>"}' ./spotcheck.py <bundle> <ws>/<docId> ...
```

The bundle holds user data: it is created mode 700 (files 600). **Never commit it.**

## Bundle format (`bundleFormat: 1`)

All JSON is UTF-8, keys sorted, two-space indent, trailing newline. Times are
ISO-8601 UTC. Lists are sorted by id unless order is meaningful (document
order, sidebar order). Two runs on the same source produce byte-identical
files; only `run.json` (timings, host) differs and it is not hashed.

```
migration-bundle-<ts>/
  manifest.json           counts, exporter version, fork commit, sha256 of every file
  report.md, report.json  count check, block-flavour table, losses
  run.json                start time, host, timings (not hashed)
  instance/
    users.json            19 users: id, email, name, avatarUrl, registered, disabled, admin, features, memberships, hasPassword (boolean only)
    app-config.json       every app_configs key; values only for an allowlist (signup allowlist, flags, translate.enabled/model, SMTP port/sender)
    published-docs.json   published docs: workspace, doc, title, publish mode, publishedAt, translation languages
    agents.json           the 4 workspace agent users and their doc grants
    old-urls.json         every bookmarkable old path (see below)
  workspaces/<wsId>/
    workspace.json        id, name, owner, members (role/state/source), agent, sharing policy, invitations, counts, system doc ids
    folders.json          tree (folders → subfolders + links, sidebar order, `index` = fractional order key), looseLinks, rows (raw)
    tags.json             tag options (id, value, color, parentId)
    collections.json      collections (rules, allowList)
    sidebar.json          favourites per user, pinned collections, explorer icons
    custom-properties.json  docCustomPropertyInfo rows
    doc-grants.json       doc_grants with principal email and `agent` flag
    blobs.json            per blob: key, mime, size, sha256, file, referencedBy [{docId, blockId, flavour}], workspaceAvatar
    docs/<docId>/
      doc.json            metadata (below)
      body.md             page-mode body
      edgeless-notes.md   text of notes shown only on the canvas (only if any)
      databases/<dbId>.json
      canvas.json         raw surface elements (only if the canvas has any)
      comments.json       comments with replies (only if any)
      translations/<lang>.md
  blobs/<wsId>/<key><ext> blob bytes; extension from the mime type
```

### doc.json

`workspaceId`, `docId`, `title` (root meta, else workspace_pages, else reader),
`titles` (all three), `createdAt`/`updatedAt` (root meta dates, else snapshot),
`snapshot` (created/updated at+by, `historyVersions`), `createdBy`/`updatedBy`
(`{userId, email, agent}`), `trash`, `trashDate`, `inRootMeta`, `mode`
(`page|edgeless`, from docProperties `primaryMode`), `tags` (`[{id,name}]`),
`properties` (raw docProperties row), `folders` (each link: folder id, order key,
path of folder names), `publish` (`published`, `visibility`, `publicRole`,
`memberDefaultRole`, `publishedAt`, `mode` = public page/edgeless,
`urlPreviewEnabled`, `blocked`), `body`, `edgelessNotes`, `databases`
(`[{id,title,rows,columns,file}]`), `canvas`, `comments`, `translations`
(`[{lang, sourceLang, status, title, error, sourceTimestamp, file}]`),
`flavourCounts`, `blocks` (every block that is not plain Markdown: id, flavour,
parentId, handling, props, `representation` = what it became in body.md,
`edgelessOnly`), `blobs` (keys used), `links.affine` (doc ids linked),
`links.oldHost` (absolute links to the old hosts), `inline` (inline attribute
statistics), `reader` (flavours the native reader reported as unsupported).

### body.md

The fork reader's Markdown (what `read_document` returns), with:

- **Page links** as `[Title](affine://<docId>)` (S6b rewrites them).
- **Databases** as the fork's marker line
  `<!-- database id=<blockId> "<title>" (<rows> rows, <cols> columns): ... -->`.
- **Images** as `![caption](blob://<key>)`; `blobs.json` maps the key to a file.
- **LaTeX blocks** as `$$\n<latex>\n$$`; **inline LaTeX** (dropped by the reader)
  as `$<latex>$`.
- **Every other block Markdown cannot carry** (attachment, bookmark, embeds) as
  one line `<!-- affine-block id=<blockId> flavour=<flavour> [blob=".." name=".." target="affine://<docId>" title=".." url=".."] -->`.
  Values are percent-escaped for `%`, `"`, `--` and newlines; `pure.ts`
  `parseBlockMarker` parses it. Full props are in doc.json `blocks`.

These replacements keep their position: each block is swapped for a sentinel
paragraph before the reader runs (the technique `database-markdown.ts` uses).
Notes with `displayMode: edgeless` are hidden in page mode and are left out of
body.md; their text goes to `edgeless-notes.md`. Blocks under the surface
(frames, edgeless text, images/embeds placed on the canvas) appear in neither:
they are listed in doc.json `blocks` with `handling: canvas`, and shapes,
connectors, mindmaps and groups are in canvas.json. Colours come out as
`<span style=...>` HTML from the reader. Translations go through the same
pipeline.

### databases/<id>.json

`databaseId`, `title`, `columns` (`id`, `name`, `type`, `options` labels for
selects, raw `data` incl. option ids/colours, `virtual` for the editor's
implicit Title), `rowCount`, `rows` (`[{id, values: {<columnId>: value}, richText?}]`),
`views` (raw: table/kanban, column widths, filters, groupBy). Values follow
`database-model.ts`: dates `YYYY-MM-DD` (nearest UTC midnight), select as its
label, multi-select as a label list, checkbox always `true`/`false`, numbers as
numbers, text as plain strings. Unlike `read_database`, every column is present
in every row (empty = `null`, `''` or `[]`). `richText` holds the Yjs delta of
a text cell that carries formatting or links.

### old-urls.json

`hosts` (`base.droneaid.fr` canonical, `base.drone-aid.fr` alias), and `paths`:
`/workspace/<ws>/<docId>` and the legacy `/share/<ws>/<docId>` for every doc
(flag `published`), `/workspace/<ws>[/all|journals|trash|collection|tag|settings]`,
`/workspace/<ws>/collection/<id>`, `/workspace/<ws>/tag/<id>` and
`/api/workspaces/<ws>/blobs/<key>`. Query strings (`mode=`, `lang=`,
`blockIds=`) are not separate entries; the redirect should keep `lang`.

### manifest.json

`bundleFormat`, `exporter` (`version`, `affineForkCommit`), `sourceBackup`,
`counts`, `checksPassed`, `files` (`path → {sha256, bytes}` for every file
except manifest.json and run.json) and `bundleSha256` (sha256 of the canonical
JSON of `files`): equal digests mean equal bundles.

## Secrets

Never exported: password hashes (only `hasPassword`), sessions, tokens, MCP
credential hashes, OAuth client secret, session signing keys, the Gemini key,
SMTP username/password/host. app-config.json lists those keys with
`valueCopied: false`.

## Files

`src/main.ts` (CLI, instance files, checks, manifest), `src/export.ts`
(workspaces, docs, blobs), `src/docs.ts` (one doc: body, databases, canvas),
`src/workspace.ts` (root and ORM docs), `src/source.ts` (SQL), `src/fork.ts`
(fork loader), `src/pure.ts` (pure transforms), `src/report.ts`, `src/bundle.ts`;
tests in `test/`.
