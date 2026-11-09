import * as Y from 'yjs';
import {
  CellInput,
  CellValue,
  ColumnSpec,
  ColumnType,
  DatabaseData,
  DatabaseError,
  columnKeys,
  createDatabaseData,
  encodeRowValues,
  isEmptyValue,
  resolveColumn,
} from '@docmost/editor-ext';
import {
  addColumn,
  addRows,
  createDatabase,
  readDatabase,
  removeColumn,
  removeRows,
  renameColumn,
  retypeColumn,
  updateRows,
} from '../../database';

/**
 * What the MCP database tools do to a page's Y.Doc, with the semantics of
 * our AFFiNE fork's tools (plugins/mcp/tools/database-edit.ts): every call
 * is validated in full before anything is written, so it applies all or
 * nothing, and a refusal is a DatabaseError saying why. The block itself
 * (layout, value rules) is S4a's: droneaid/database and editor-ext.
 */

/** Column types MCP writes. `rich-text` is AFFiNE's name for `text`. */
export const WRITABLE_TYPES = [
  'text',
  'rich-text',
  'number',
  'checkbox',
  'date',
  'link',
  'select',
  'multi-select',
] as const;
export type WritableType = (typeof WRITABLE_TYPES)[number];

export const blockType = (type: WritableType): ColumnType =>
  type === 'rich-text' ? 'text' : type;

export type RowValues = Record<string, CellInput>;

// ---------------------------------------------------------------- read

export type ColumnInfo = {
  id: string;
  name: string;
  type: ColumnType;
  options?: string[];
};

export function describeColumns(data: DatabaseData): ColumnInfo[] {
  return data.columns.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    ...(c.type === 'select' || c.type === 'multi-select'
      ? { options: c.options.map((o) => o.label) }
      : {}),
  }));
}

export type RowOutput = { id: string; values: Record<string, CellValue> };

/**
 * A row as the agent sees it: values by column name (by id when names
 * clash), empty values left out. Checkbox values are always given, `true`
 * or `false`, so a rule such as "never email a guest whose `blacklisted`
 * is set" never depends on a key being absent.
 */
export function rowOutput(data: DatabaseData, index: number): RowOutput {
  const keys = columnKeys(data.columns);
  const row = data.rows[index];
  const values: Record<string, CellValue> = {};
  for (const column of data.columns) {
    const value = row.cells[column.id] ?? null;
    const key = keys.get(column.id) ?? column.id;
    if (column.type === 'checkbox') values[key] = value === true;
    else if (!isEmptyValue(value)) values[key] = value;
  }
  return { id: row.id, values };
}

const searchText = (value: CellValue) =>
  Array.isArray(value) ? value.join(', ') : String(value);

export type ReadQuery = { search?: string; offset?: number; limit: number };

/** Columns plus one page of rows, filtered by `search` (any value contains it). */
export function readView(data: DatabaseData, query: ReadQuery) {
  const offset = query.offset ?? 0;
  let rows = data.rows.map((_, i) => rowOutput(data, i));
  const needle = query.search?.trim().toLowerCase();
  if (needle) {
    rows = rows.filter((row) =>
      Object.values(row.values).some(
        (value) =>
          value !== false && searchText(value).toLowerCase().includes(needle),
      ),
    );
  }
  const page = rows.slice(offset, offset + query.limit);
  const next = offset + page.length;
  return {
    databaseId: data.id,
    title: data.title,
    columns: describeColumns(data),
    totalRows: data.rows.length,
    ...(needle ? { matchingRows: rows.length } : {}),
    offset,
    rows: page,
    ...(next < rows.length ? { nextOffset: next } : {}),
  };
}

/** The database with this id, or the only one; the same refusals as the write path. */
export function pickDatabase(
  databases: DatabaseData[],
  databaseId?: string,
): DatabaseData {
  if (databaseId) {
    const matches = databases.filter((db) => db.id === databaseId);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new DatabaseError(
        `Database ${databaseId} appears ${matches.length} times in this page.`,
      );
    }
    throw new DatabaseError(`Database ${databaseId} not found in this document.`);
  }
  if (databases.length === 1) return databases[0];
  if (!databases.length) throw new DatabaseError('This document has no database.');
  throw new DatabaseError(
    `This document has ${databases.length} databases; pass databaseId.`,
  );
}

// ---------------------------------------------------------------- create

export type ColumnInput = string | { name: string; type: WritableType };

export type CreateSpec = {
  title: string;
  columns: ColumnInput[];
  rows: CellInput[][];
};

/**
 * Column specs for create_database: the first column is the row title
 * (whatever type it was given), an empty name becomes "Column N", and a
 * repeated name gets " (2)", " (3)" (the block needs unique names; a CSV
 * header may repeat one).
 */
export function createColumns(columns: ColumnInput[]): {
  specs: ColumnSpec[];
  renamed: { from: string; to: string }[];
} {
  const taken = new Set<string>();
  const renamed: { from: string; to: string }[] = [];
  const specs = columns.map((column, i): ColumnSpec => {
    const given = typeof column === 'string' ? column : column.name;
    const base = String(given ?? '').trim() || `Column ${i + 1}`;
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (${n})`;
    taken.add(name.toLowerCase());
    if (name !== String(given ?? '').trim()) renamed.push({ from: given, to: name });
    const type: ColumnType =
      i === 0
        ? 'title'
        : typeof column === 'string'
          ? 'text'
          : blockType(column.type);
    return { name, type };
  });
  return { specs, renamed };
}

/** Appends a database with positional rows (one list of values per row). */
export function createFromSpec(doc: Y.Doc, spec: CreateSpec) {
  if (!spec.columns.length) throw new DatabaseError('Give at least one column.');
  const { specs, renamed } = createColumns(spec.columns);
  const probe = createDatabaseData({ columns: specs });
  const rows = spec.rows.map((row, r) => {
    if (row.length > specs.length) {
      throw new DatabaseError(
        `Row ${r + 1} has more values than the ${specs.length} columns.`,
      );
    }
    const values: RowValues = {};
    row.forEach((value, i) => {
      if (value !== null && value !== undefined) values[specs[i].name] = value;
    });
    withRow(`Row ${r + 1}`, () => encodeRowValues(probe.columns, values));
    return values;
  });
  const data = createDatabase(doc, {
    title: spec.title,
    columns: specs,
    rows,
  });
  return {
    databaseId: data.id,
    rows: data.rows.length,
    columns: data.columns.length,
    ...(renamed.length ? { renamedColumns: renamed } : {}),
  };
}

// ---------------------------------------------------------------- rows

function withRow<T>(label: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof DatabaseError) {
      throw new DatabaseError(`${label}: ${error.message}`);
    }
    throw error;
  }
}

function assertRows(data: DatabaseData, rowIds: string[]) {
  const known = new Set(data.rows.map((r) => r.id));
  const missing = [...new Set(rowIds)].filter((id) => !known.has(id));
  if (missing.length) {
    throw new DatabaseError(
      `Not rows of this database: ${missing.join(', ')}. Read it again with read_database.`,
    );
  }
}

export function addRowsChecked(
  doc: Y.Doc,
  databaseId: string,
  rows: RowValues[],
): string[] {
  const data = readDatabase(doc, databaseId);
  rows.forEach((values, i) =>
    withRow(`Row ${i + 1}`, () => encodeRowValues(data.columns, values)),
  );
  return addRows(doc, databaseId, rows);
}

export function updateRowsChecked(
  doc: Y.Doc,
  databaseId: string,
  updates: { rowId: string; values: RowValues }[],
): number {
  const data = readDatabase(doc, databaseId);
  assertRows(
    data,
    updates.map((u) => u.rowId),
  );
  updates.forEach((u) =>
    withRow(`Row ${u.rowId}`, () => encodeRowValues(data.columns, u.values)),
  );
  updateRows(
    doc,
    databaseId,
    updates.map((u) => ({ id: u.rowId, values: u.values })),
  );
  return updates.length;
}

export function removeRowsChecked(
  doc: Y.Doc,
  databaseId: string,
  rowIds: string[],
): number {
  const unique = [...new Set(rowIds)];
  assertRows(readDatabase(doc, databaseId), unique);
  removeRows(doc, databaseId, unique);
  return unique.length;
}

// ---------------------------------------------------------------- columns

export type ColumnOp =
  | { op: 'add'; name: string; type: WritableType }
  | { op: 'rename'; column: string; name: string }
  | { op: 'remove'; column: string }
  | { op: 'set_type'; column: string; type: WritableType };

function applyOp(doc: Y.Doc, databaseId: string, op: ColumnOp) {
  switch (op.op) {
    case 'add': {
      const column = addColumn(doc, databaseId, {
        name: op.name,
        type: blockType(op.type),
      });
      return { op: 'add', id: column.id, name: column.name, type: column.type };
    }
    case 'rename': {
      const column = renameColumn(doc, databaseId, op.column, op.name);
      return { op: 'rename', id: column.id, name: column.name };
    }
    case 'remove': {
      const column = resolveColumn(readDatabase(doc, databaseId).columns, op.column);
      removeColumn(doc, databaseId, column.id);
      return { op: 'remove', id: column.id, name: column.name };
    }
    case 'set_type': {
      const before = readDatabase(doc, databaseId);
      const column = resolveColumn(before.columns, op.column);
      const to = blockType(op.type);
      retypeColumn(doc, databaseId, column.id, to);
      const after = readDatabase(doc, databaseId);
      // Values that did not fit the new type and were cleared (an unchecked
      // checkbox is a value, as in AFFiNE).
      const lost =
        to === 'checkbox'
          ? 0
          : before.rows.filter(
              (row, i) =>
                !isEmptyValue(row.cells[column.id] ?? null) &&
                isEmptyValue(after.rows[i]?.cells[column.id] ?? null),
            ).length;
      return {
        op: 'set_type',
        id: column.id,
        name: column.name,
        from: column.type,
        to,
        valuesThatDidNotConvert: lost,
      };
    }
  }
}

/**
 * Runs `ops` in order, all or nothing: first on a copy of the doc, so an op
 * that fails after earlier ones changed something leaves the page as it was;
 * then, only if every op succeeded, on the doc itself.
 */
export function applyColumnOps(
  doc: Y.Doc,
  databaseId: string,
  ops: ColumnOp[],
): Record<string, unknown>[] {
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    ops.forEach((op, i) =>
      withRow(`Op ${i + 1} (${op.op})`, () => applyOp(copy, databaseId, op)),
    );
  } finally {
    copy.destroy();
  }
  return ops.map((op) => applyOp(doc, databaseId, op));
}
