import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import {
  CellValue,
  ColumnType,
  DATABASE_CELL_NODE,
  DATABASE_COLUMN_NODE,
  DATABASE_ROW_NODE,
  DatabaseColumn,
  DatabaseError,
  DatabaseViewState,
  SelectOption,
  columnAttrs,
  isEmptyView,
  newColumn,
  planRetype,
  readCellValue,
  readColumnAttrs,
  readView,
  relabelValue,
  RetypePlan,
  viewForRetype,
  viewWithRenamedLabel,
  viewWithoutColumn,
} from "@docmost/editor-ext";
import {
  GetPos,
  Located,
  childrenOf,
  dispatch,
  findColumn,
  locateDatabase,
} from "./commands";

/**
 * Column edits as single ProseMirror transactions. Each one changes the
 * column node and, where values must follow (retype, option rename or
 * delete, column delete), the affected cell nodes, plus the view rules that
 * name the column.
 */

const MIN_WIDTH = 60;
const MAX_WIDTH = 800;

function columnNodes(db: Located): Located[] {
  return childrenOf(db).filter((c) => c.node.type.name === DATABASE_COLUMN_NODE);
}

function rowNodes(db: Located): Located[] {
  return childrenOf(db).filter((c) => c.node.type.name === DATABASE_ROW_NODE);
}

/** The cells of `columnId` in a row (normally zero or one). */
function cellsOf(row: Located, columnId: string): Located[] {
  return childrenOf(row).filter(
    (c) => c.node.type.name === DATABASE_CELL_NODE && c.node.attrs.column === columnId,
  );
}

/** The value a reader sees for a row (last duplicate wins, like model.ts). */
function rowValue(row: Located, column: DatabaseColumn): CellValue {
  const cells = cellsOf(row, column.id);
  const raw = cells.length ? cells[cells.length - 1].node.attrs.value : null;
  return readCellValue(column, raw);
}

/**
 * Writes one cell inside `tr`. Positions come from the untouched document
 * and are mapped through `tr`, so calls may run in any order.
 */
function writeCell(tr: Transaction, row: Located, columnId: string, value: CellValue) {
  const cells = cellsOf(row, columnId);
  if (!cells.length) {
    if (value === null) return;
    const cell = tr.doc.type.schema.nodes[DATABASE_CELL_NODE].create({
      column: columnId,
      value,
    });
    tr.insert(tr.mapping.map(row.pos + row.node.nodeSize - 1, -1), cell);
    return;
  }
  const keep = cells[cells.length - 1];
  for (const extra of cells.slice(0, -1).reverse()) {
    const from = tr.mapping.map(extra.pos, 1);
    tr.delete(from, from + extra.node.nodeSize);
  }
  const at = tr.mapping.map(keep.pos, 1);
  if (value === null) tr.delete(at, at + keep.node.nodeSize);
  else if (keep.node.attrs.value !== value) tr.setNodeAttribute(at, "value", value);
}

function setView(tr: Transaction, dbPos: number, view: DatabaseViewState) {
  tr.setNodeAttribute(tr.mapping.map(dbPos, 1), "view", isEmptyView(view) ? null : view);
}

function viewOf(db: Located): DatabaseViewState {
  return readView(db.node.attrs.view);
}

function located(editor: Editor, getPos: GetPos, columnId: string) {
  const db = locateDatabase(editor, getPos);
  const col = db && findColumn(db, columnId);
  if (!db || !col) return null;
  return { db, col, column: readColumnAttrs(col.node.attrs) };
}

/**
 * Inserts a column next to `anchorColumnId` (or after the last column) and
 * returns its id.
 */
export function addColumn(
  editor: Editor,
  getPos: GetPos,
  spec: { name: string; type: ColumnType },
  anchor?: { columnId: string; side: "left" | "right" },
): string | null {
  const db = locateDatabase(editor, getPos);
  if (!db) return null;
  const column = newColumn(spec);
  const columns = columnNodes(db);
  const target = anchor
    ? columns.find((c) => c.node.attrs.id === anchor.columnId)
    : columns[columns.length - 1];
  const at = !target
    ? db.pos + 1
    : anchor?.side === "left"
      ? target.pos
      : target.pos + target.node.nodeSize;
  const node = editor.schema.nodes[DATABASE_COLUMN_NODE].create(columnAttrs(column));
  dispatch(editor, editor.state.tr.insert(at, node));
  return column.id;
}

export function renameColumn(editor: Editor, getPos: GetPos, columnId: string, name: string) {
  const found = located(editor, getPos, columnId);
  const next = name.trim();
  if (!found || !next || found.column.name === next) return;
  dispatch(editor, editor.state.tr.setNodeAttribute(found.col.pos, "name", next));
}

export function setColumnWidth(
  editor: Editor,
  getPos: GetPos,
  columnId: string,
  width: number,
) {
  const found = located(editor, getPos, columnId);
  if (!found) return;
  const next = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)));
  if (found.column.width === next) return;
  dispatch(editor, editor.state.tr.setNodeAttribute(found.col.pos, "width", next));
}

/** Moves a column before or after another column. */
export function moveColumn(
  editor: Editor,
  getPos: GetPos,
  columnId: string,
  targetColumnId: string,
  place: "before" | "after",
) {
  if (columnId === targetColumnId) return;
  const db = locateDatabase(editor, getPos);
  if (!db) return;
  const col = findColumn(db, columnId);
  const target = findColumn(db, targetColumnId);
  if (!col || !target) return;
  const at = place === "before" ? target.pos : target.pos + target.node.nodeSize;
  if (at === col.pos || at === col.pos + col.node.nodeSize) return;
  const { tr } = editor.state;
  tr.insert(at, col.node);
  const from = tr.mapping.map(col.pos, 1);
  tr.delete(from, from + col.node.nodeSize);
  dispatch(editor, tr);
}

/** Removes a column, its cells and the view rules naming it. */
export function removeColumn(editor: Editor, getPos: GetPos, columnId: string) {
  const found = located(editor, getPos, columnId);
  if (!found) return;
  if (found.column.type === "title") {
    throw new DatabaseError("The title column cannot be removed.");
  }
  const { db } = found;
  const { tr } = editor.state;
  const view = viewOf(db);
  const nextView = viewWithoutColumn(view, columnId);
  if (nextView.sorts.length !== view.sorts.length || nextView.filters.length !== view.filters.length) {
    setView(tr, db.pos, nextView);
  }
  for (const row of rowNodes(db)) {
    for (const cell of cellsOf(row, columnId)) {
      const from = tr.mapping.map(cell.pos, 1);
      tr.delete(from, from + cell.node.nodeSize);
    }
  }
  for (const col of columnNodes(db).filter((c) => c.node.attrs.id === columnId)) {
    const from = tr.mapping.map(col.pos, 1);
    tr.delete(from, from + col.node.nodeSize);
  }
  dispatch(editor, tr);
}

/** What retyping would do to the column's values (for the lossy warning). */
export function previewRetype(
  editor: Editor,
  getPos: GetPos,
  columnId: string,
  type: ColumnType,
): RetypePlan | null {
  const found = located(editor, getPos, columnId);
  if (!found) return null;
  const values = rowNodes(found.db).map((row) => rowValue(row, found.column));
  return planRetype(found.column, type, values);
}

/** Changes a column's type and converts every value. */
export function retypeColumn(
  editor: Editor,
  getPos: GetPos,
  columnId: string,
  type: ColumnType,
) {
  const found = located(editor, getPos, columnId);
  if (!found || found.column.type === type) return;
  const { db, col, column } = found;
  const rows = rowNodes(db);
  const plan = planRetype(column, type, rows.map((row) => rowValue(row, column)));
  const { tr } = editor.state;
  tr.setNodeAttribute(col.pos, "type", type);
  tr.setNodeAttribute(col.pos, "options", plan.column.options);
  const view = viewOf(db);
  const nextView = viewForRetype(view, columnId);
  if (nextView.filters.length !== view.filters.length) setView(tr, db.pos, nextView);
  rows.forEach((row, i) => {
    const before = rowValue(row, column);
    if (before === null && plan.values[i] === null) return;
    writeCell(tr, row, columnId, plan.values[i]);
  });
  dispatch(editor, tr);
}

export interface OptionChange {
  /** The full new option list. */
  options: SelectOption[];
  /** Old label -> new label; cells and filters follow. */
  renames?: Record<string, string>;
  /** Labels to clear from cells. */
  removed?: string[];
}

/** Replaces a select column's options, rewriting cells for renames and deletes. */
export function changeOptions(
  editor: Editor,
  getPos: GetPos,
  columnId: string,
  change: OptionChange,
) {
  const found = located(editor, getPos, columnId);
  if (!found) return;
  const { db, col, column } = found;
  if (column.type !== "select" && column.type !== "multi-select") return;
  const renames = change.renames ?? {};
  const removed = new Set(change.removed ?? []);
  const { tr } = editor.state;
  tr.setNodeAttribute(col.pos, "options", change.options);
  if (Object.keys(renames).length || removed.size) {
    for (const row of rowNodes(db)) {
      const before = rowValue(row, column);
      const after = relabelValue(column, before, renames, removed);
      if (after !== before) writeCell(tr, row, columnId, after);
    }
    let view = viewOf(db);
    const original = view;
    for (const [from, to] of Object.entries(renames)) {
      view = viewWithRenamedLabel(view, columnId, from, to);
    }
    if (view !== original) setView(tr, db.pos, view);
  }
  dispatch(editor, tr);
}

/** How many rows use an option label (for the delete confirmation). */
export function countOptionUse(
  editor: Editor,
  getPos: GetPos,
  columnId: string,
  label: string,
): number {
  const found = located(editor, getPos, columnId);
  if (!found) return 0;
  return rowNodes(found.db).filter((row) => {
    const value = rowValue(row, found.column);
    return value === label || (Array.isArray(value) && value.includes(label));
  }).length;
}
