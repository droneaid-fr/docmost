# ADR 0001: Database block storage

- Status: accepted (S4a, 2026-11-08)
- Context: migration plan D4 (native database block) and D5 (clean room). This block is our
  own design. It shares nothing with Docmost's EE "Bases".

## Decision

A database is a tree of **ProseMirror nodes inside the page's normal document**. One cell is
one leaf node, and its value is an attribute on that node:

```
droneaidDatabase        attrs: id, title                   content: (droneaidDatabaseColumn | droneaidDatabaseRow)*
├─ droneaidDatabaseColumn  attrs: id, name, type, options, width     (leaf)
└─ droneaidDatabaseRow     attrs: id                       content: droneaidDatabaseCell*
   └─ droneaidDatabaseCell attrs: column (column id), value (typed JSON)   (leaf)
```

This is option (a) from the brief, with the column schema stored as nodes as well, not as one
attribute. The database node is an `atom`. Its React node view has no `contentDOM`, so
ProseMirror never builds DOM for the 7,000 child nodes. The view draws a virtualised table
from the node itself.

## Why

What y-prosemirror merges: every ProseMirror node becomes a `Y.XmlElement`. Attributes on that
element are a per-key map, and children form a list. Edits to different elements, or to
different keys of one element, therefore merge. Only a write to the same key of the same
element is resolved last-writer-wins. In this layout:

| Concurrent edit | Touches | Result |
|---|---|---|
| Two cells in different rows | two cell elements | both kept |
| Two cells in the same row | two cell elements, or two inserts into the row's child list | both kept |
| Add row while someone edits a cell | database child list and a cell element | both kept |
| Add column while someone adds a row | database child list, two inserts | both kept; the new row has no cell for the new column, which reads as empty |
| Rename column and change its type at the same time | two keys of one column element | both kept |
| Same cell, two values | one key of one element | last writer wins (allowed by the requirements) |
| Two people add a select option to the same column | `options` key of one column | one option list wins. **No value is lost**: cells store option **labels**, so a cell whose label is not in `options` still shows (grey) and can be re-added. |

Persistence and everything built on `pages.content` keep working without hooks, because the
data lives in the `default` fragment:

- `onStoreDocument` writes `content` (`TiptapTransformer.fromYdoc`) and `text_content`
  (`jsonToText`). The database node's `renderText` emits the rows, so full-text search sees
  them.
- Page history stores `content` snapshots. Restore pushes that JSON back into the editor.
  Page duplicate goes `jsonToNode` → `createYdocFromJson`. Copy/paste goes through
  `renderHTML`/`parseHTML`. Import and export go through `jsonToHtml` and `htmlToMarkdown`.
  All of these use the server schema, so the four node types are registered in
  `tiptapExtensions` (`collaboration.util.ts`). `jsonToNode` strips unknown node types and
  `TiptapTransformer.toYdoc` refuses them, so without that registration the block would be
  silently dropped. A persistence test round-trips 777 rows × 8 columns through
  `content` → ydoc → `content`.
- Schema validity is robust to merges. y-prosemirror **deletes** a Y element that it cannot
  turn into a valid node. For that reason the content expressions are deliberately loose:
  `(column | row)*` in any order, and `cell*`. Two concurrent inserts that interleave can
  never make a database invalid. Readers pick columns and rows by type and treat a missing or
  duplicate cell deterministically: a missing cell is empty, and of duplicates the last one
  wins.

Rendering cost (777 × 8): the PM document gains about 7,000 small nodes, and y-prosemirror
keeps about 7,000 Y elements in its mapping. A local edit runs y-prosemirror's diff. The diff
skips unchanged siblings by identity and descends only into the edited row. The node view
re-derives the table model from the node on each change, a linear walk of under a millisecond
or so. Rows are memoised on the identity of their PM node, so only the edited row re-renders,
and only the visible rows are mounted. Measured numbers are under "Measurements" below.

## Rejected options

**(b) A `Y.Map`/`Y.Array` beside the ProseMirror fragment, referenced by an atom node.** This
option merges well. It is the AFFiNE layout. But Docmost persists, searches, snapshots,
restores, duplicates, exports and imports **only** the `default` fragment as `content`. Every
one of those paths would need a hook:

- persistence would need a projection into `content` for Markdown, search and MCP;
- history snapshots of `content` would not contain the rows, so restoring a version would not
  restore them;
- `duplicatePage` builds a fresh ydoc from `content` and would lose the data;
- the Markdown and HTML import path would need its own writer.

Those hooks are edits to upstream files (persistence extension, history processor, page
service, import service). D3 is meant to minimise exactly such edits. There is also a
consistency risk. The fragment and the map would be two sources of truth for one block:
deleting the atom node would orphan the map, and undo would cover one but not the other.

**(a′) Rows as nodes but the column schema (or the whole table) as one JSON attribute.** This
is simpler, but an attribute is replaced whole. Concurrent edits to two cells, or to two
columns, would lose one of them. That violates the no-lost-writes requirement.

**Cells with inline text content (character-level merge).** This would give real-time merge
inside a text cell. But it costs a contentDOM per cell or a custom editor per cell, and it
gives typed values (number, date, select) no benefit. The requirements accept
last-writer-wins on one cell. A later step can still switch the text and title columns to
`Y.Text`-backed content. That change would need a schema migration.

## Values

The `value` attribute holds typed JSON, and `null` (attribute absent) means empty:

| Column type | Stored value |
|---|---|
| `title`, `text` | string |
| `number` | finite number |
| `select` | option label (string) |
| `multi-select` | array of option labels |
| `date` | `"YYYY-MM-DD"` (no time zone; AFFiNE millisecond values convert to the nearest UTC day) |
| `checkbox` | `true` (unchecked is empty) |
| `link` | URL string |

Each database has exactly one `title` column. It cannot be removed or retyped. Validation and
conversion live in `packages/editor-ext/src/lib/droneaid/database/values.ts` and are shared by
the client, the server and MCP.

## Markdown

Export is a marker line followed by a GFM table:

```
<!-- droneaid:database {"id":"…","title":"…","columns":[…],"rows":["rowId",…]} -->
| Name | Status | … |
| --- | --- | --- |
| Alpha | Done | … |
```

Plain Markdown readers, `read_document`, page export and search see an ordinary table. The
marked extension recognises the marker and turns the marker plus the table back into the
block. It keeps the ids, types and options, and it parses each cell by its column type, so
Markdown import round-trips. Limits: rows are matched to ids by position; newlines inside a
text cell become spaces; a multi-select label that contains a comma splits in two. A table
without a marker imports as a normal table, never as a database.

## Consequences

- Upstream touches are registration only: the editor-ext index, the marked and turndown rule
  lists, the server `tiptapExtensions`, the client `mainExtensions`, and one slash-menu entry.
- Server-side edits (MCP, S4c) operate on the Y elements inside the `default` fragment through
  the collaboration server (`openDirectConnection` + `transact`). Model:
  `apps/server/src/droneaid/database/`.
- Sort and filter (S4b) are view state. They will be one more attribute on the database node,
  where last-writer-wins is acceptable for view settings.
- A copy and paste of a database inside one page duplicates its `id`. MCP resolves a
  database by id and reports ambiguity. Re-iding on paste is open work.

## Measurements (S4a, dev server, headless Chromium, 777 rows × 8 columns)

- Page `content`: 487 KB of JSON; `text_content`: 71 KB. Creating the page over REST took
  0.15 s.
- Open: 1.3 s from navigation to the first table row (dev build, cold Vite cache included).
  About 30 rows are mounted at any time.
- Scrolling the full table, 200 px per frame, 140 frames: 20–46 ms average and 73 ms p95
  frame time in headless Chromium with software rendering. The last row is reached.
- Committing a cell edit (blur → PM transaction → y-prosemirror → Yjs): 4–6 ms.
- Markdown export of the page: 87 KB, with all 777 rows as table lines.

## MCP tools (S4c, 2026-11-09)

`apps/server/src/droneaid/mcp/tools/databases.ts` (tools) and `database-ops.ts` (what they do
to the Y.Doc). Names, arguments, replies and refusals follow our AFFiNE fork
(`plugins/mcp/tools/databases.ts`), so the agent's prompts and `pdf-import` keep working:
`read_database`, `create_database`, `add_database_rows`, `update_database_rows`,
`remove_database_rows`, `update_database_columns` (`add`, `rename`, `remove`, `set_type`).

- Every write runs in one `withLiveDoc` transaction and is validated in full first; a refusal
  starts with "Nothing was changed." `update_database_columns` runs its ops on a copy of the
  doc first, so an op that fails after earlier ones applies none of them.
- Type names are the block's; `rich-text` is accepted as `text`. AFFiNE's `progress` type does
  not exist here and is refused.
- `create_database` makes repeated or empty column names unique (`Name (2)`, `Column 3`) and
  reports them in `renamedColumns`; the block needs unique names, a CSV header may not have them.
- `read_database` gives checkbox values always as `true`/`false` (AFFiNE left `false` out), so a
  rule such as the guest-list blacklist never depends on a missing key. Other empty values are
  left out. `search` matches the given values' text (`true` for a checked box).
- Reads use the live doc when this collaboration server has it loaded, else the stored
  `content`; they never open a connection, so a read neither loads nor saves the page.
- `read_document` shows each database as one line,
  `<!-- database id=X "Title" (N rows, M columns): ... -->`; `update_document` keeps the database
  where that line (long or short form) stands.

**No server-side `import_csv`.** The agent's `import_csv` lives in its `pdf-import` helper,
next to the file it reads; with `as_database` it calls `create_document` and then
`create_database` with all rows in one call (777 rows × 8 columns take about 0.2 s end to end
locally). A server tool would need the same rows sent over MCP, so it adds nothing. AFFiNE never
had one either.
