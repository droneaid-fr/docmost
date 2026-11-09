import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import {
  CellValue,
  DatabaseViewState,
  DATABASE_CELL_NODE,
  DATABASE_COLUMN_NODE,
  DATABASE_NODE,
  DATABASE_ROW_NODE,
  DatabaseColumn,
  isEmptyView,
  newDatabaseId,
  optionsWith,
  valueLabels,
} from "@docmost/editor-ext";

/**
 * Edits to a database block as ProseMirror transactions. Each touches only
 * the nodes it changes (one cell, one row, one column), so y-prosemirror
 * turns it into an equally small Yjs change and concurrent edits merge.
 */

export type GetPos = () => number | undefined;

export interface Located {
  pos: number;
  node: PMNode;
}

/** The database node, re-read from the current state (never stale). */
export function locateDatabase(editor: Editor, getPos: GetPos): Located | null {
  const pos = getPos();
  if (typeof pos !== "number") return null;
  const node = editor.state.doc.nodeAt(pos);
  return node?.type.name === DATABASE_NODE ? { pos, node } : null;
}

export function childrenOf(parent: Located): Located[] {
  const list: Located[] = [];
  parent.node.forEach((node, offset) => {
    list.push({ pos: parent.pos + 1 + offset, node });
  });
  return list;
}

export function findRow(db: Located, rowId: string): Located | undefined {
  return childrenOf(db).find(
    (c) => c.node.type.name === DATABASE_ROW_NODE && c.node.attrs.id === rowId,
  );
}

export function findColumn(db: Located, columnId: string): Located | undefined {
  return childrenOf(db).find(
    (c) => c.node.type.name === DATABASE_COLUMN_NODE && c.node.attrs.id === columnId,
  );
}

export function dispatch(editor: Editor, tr: any) {
  editor.view.dispatch(tr);
}

/** Sets one cell's value; adds new select labels to the column's options. */
export function setCellValue(
  editor: Editor,
  getPos: GetPos,
  rowId: string,
  column: DatabaseColumn,
  value: CellValue,
) {
  const db = locateDatabase(editor, getPos);
  if (!db) return;
  const row = findRow(db, rowId);
  if (!row) return;
  const { tr, schema } = editor.state;

  const cells = childrenOf(row).filter(
    (c) => c.node.type.name === DATABASE_CELL_NODE && c.node.attrs.column === column.id,
  );
  // Positions after the edit point shift, so work from the end backwards.
  if (cells.length) {
    const keep = cells[cells.length - 1];
    if (keep.node.attrs.value !== value) {
      tr.setNodeAttribute(keep.pos, "value", value);
    }
    for (const extra of cells.slice(0, -1).reverse()) {
      tr.delete(extra.pos, extra.pos + extra.node.nodeSize);
    }
  } else if (value !== null) {
    const cell = schema.nodes[DATABASE_CELL_NODE].create({ column: column.id, value });
    tr.insert(row.pos + row.node.nodeSize - 1, cell);
  }

  const selectable = column.type === "select" || column.type === "multi-select";
  const labels = selectable ? valueLabels(value) : [];
  if (labels.length) {
    const options = optionsWith(column.options, labels);
    const colNode = findColumn(db, column.id);
    if (options !== column.options && colNode) {
      tr.setNodeAttribute(tr.mapping.map(colNode.pos), "options", options);
    }
  }
  if (tr.docChanged) dispatch(editor, tr);
}

/** Appends an empty row (or after `afterRowId`); returns its id. */
export function addRow(
  editor: Editor,
  getPos: GetPos,
  afterRowId?: string,
): string | null {
  const db = locateDatabase(editor, getPos);
  if (!db) return null;
  const rows = childrenOf(db).filter((c) => c.node.type.name === DATABASE_ROW_NODE);
  const after = afterRowId ? findRow(db, afterRowId) : rows[rows.length - 1];
  const at = after ? after.pos + after.node.nodeSize : db.pos + db.node.nodeSize - 1;
  const id = newDatabaseId();
  const row = editor.schema.nodes[DATABASE_ROW_NODE].create({ id });
  dispatch(editor, editor.state.tr.insert(at, row));
  return id;
}

export function removeRow(editor: Editor, getPos: GetPos, rowId: string) {
  const db = locateDatabase(editor, getPos);
  const row = db && findRow(db, rowId);
  if (!row) return;
  dispatch(editor, editor.state.tr.delete(row.pos, row.pos + row.node.nodeSize));
}

export function setDatabaseTitle(editor: Editor, getPos: GetPos, title: string) {
  const db = locateDatabase(editor, getPos);
  if (!db || db.node.attrs.title === title) return;
  dispatch(editor, editor.state.tr.setNodeAttribute(db.pos, "title", title));
}

/** Deletes several rows in one transaction. */
export function removeRows(editor: Editor, getPos: GetPos, rowIds: string[]) {
  const db = locateDatabase(editor, getPos);
  if (!db || !rowIds.length) return;
  const ids = new Set(rowIds);
  const rows = childrenOf(db).filter(
    (c) => c.node.type.name === DATABASE_ROW_NODE && ids.has(c.node.attrs.id),
  );
  if (!rows.length) return;
  const { tr } = editor.state;
  for (const row of rows.reverse()) tr.delete(row.pos, row.pos + row.node.nodeSize);
  dispatch(editor, tr);
}

/**
 * Moves a row before or after another row (document order). The row is
 * re-inserted, so a concurrent edit by someone else to that row while it
 * moves is lost; the move itself is one transaction.
 */
export function moveRow(
  editor: Editor,
  getPos: GetPos,
  rowId: string,
  targetRowId: string,
  place: "before" | "after",
) {
  if (rowId === targetRowId) return;
  const db = locateDatabase(editor, getPos);
  if (!db) return;
  const row = findRow(db, rowId);
  const target = findRow(db, targetRowId);
  if (!row || !target) return;
  const at = place === "before" ? target.pos : target.pos + target.node.nodeSize;
  if (at === row.pos || at === row.pos + row.node.nodeSize) return;
  const { tr } = editor.state;
  tr.insert(at, row.node);
  const from = tr.mapping.map(row.pos, 1);
  tr.delete(from, from + row.node.nodeSize);
  dispatch(editor, tr);
}

/** Stores the shared sort and filter state on the database node. */
export function setDatabaseView(
  editor: Editor,
  getPos: GetPos,
  view: DatabaseViewState,
) {
  const db = locateDatabase(editor, getPos);
  if (!db) return;
  const next = isEmptyView(view) ? null : view;
  if (JSON.stringify(db.node.attrs.view ?? null) === JSON.stringify(next)) return;
  dispatch(editor, editor.state.tr.setNodeAttribute(db.pos, "view", next));
}
