import * as Y from 'yjs';
import {
  CellInput,
  CellValue,
  ColumnSpec,
  ColumnType,
  DATABASE_CELL_NODE,
  DATABASE_COLUMN_NODE,
  DATABASE_NODE,
  DATABASE_ROW_NODE,
  DatabaseColumn,
  DatabaseData,
  DatabaseError,
  DatabaseSpec,
  SelectOption,
  TreeAdapter,
  columnAttrs,
  convertValue,
  createDatabaseData,
  databaseToJson,
  encodeRowValues,
  isColumnType,
  newColumn,
  newDatabaseId,
  optionsWith,
  readDatabaseTree,
  readOptions,
  resolveColumn,
  valueLabels,
} from '@docmost/editor-ext';

/**
 * The database block inside a page's Y.Doc (the `default` XmlFragment that
 * y-prosemirror syncs). Reads are typed; every mutation validates first and
 * then applies as one Yjs transaction, touching only the elements it changes
 * so concurrent edits elsewhere merge. Server callers (MCP, S4c) run these
 * inside the collaboration server's direct connection, so open editors stay
 * consistent:
 *
 *   await collaborationHandler.withYdocConnection(hocuspocus, `page.${id}`, {},
 *     (doc) => addRows(doc, databaseId, rows));
 *
 * See droneaid/docs/adr-0001-database-block.md for the layout.
 */

export const DEFAULT_FIELD = 'default';

const yAdapter: TreeAdapter<Y.XmlElement> = {
  type: (el) => el.nodeName,
  attrs: (el) => el.getAttributes() as Record<string, unknown>,
  children: (el) =>
    el.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement),
};

export interface DatabaseRef {
  id: string;
  title: string;
  element: Y.XmlElement;
}

function children(
  parent: Y.XmlFragment | Y.XmlElement,
): (Y.XmlElement | Y.XmlText)[] {
  return parent.toArray() as (Y.XmlElement | Y.XmlText)[];
}

/** Every database in the doc, in document order (nested blocks included). */
export function findDatabases(
  doc: Y.Doc,
  field = DEFAULT_FIELD,
): DatabaseRef[] {
  const found: DatabaseRef[] = [];
  const walk = (parent: Y.XmlFragment | Y.XmlElement) => {
    for (const child of children(parent)) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === DATABASE_NODE) {
        found.push({
          id: String(child.getAttribute('id') ?? ''),
          title: String(child.getAttribute('title') ?? ''),
          element: child,
        });
      } else {
        walk(child);
      }
    }
  };
  walk(doc.getXmlFragment(field));
  return found;
}

/** The database with this id, or the only one when no id is given. */
export function resolveDatabase(
  doc: Y.Doc,
  databaseId?: string,
  field = DEFAULT_FIELD,
): DatabaseRef {
  const all = findDatabases(doc, field);
  if (databaseId) {
    let matches = all.filter((db) => db.id === databaseId);
    if (!matches.length) {
      // The agent often names a database by its title ("Guests").
      const title = databaseId.trim().toLocaleLowerCase();
      const named = all.filter(
        (db) => (db.title ?? '').trim().toLocaleLowerCase() === title,
      );
      if (named.length === 1) matches = named;
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new DatabaseError(
        `Database ${databaseId} appears ${matches.length} times in this page.`,
      );
    }
    throw new DatabaseError(`Database ${databaseId} not found in this page.`);
  }
  if (all.length === 1) return all[0];
  if (!all.length) throw new DatabaseError('This page has no database.');
  throw new DatabaseError(
    `This page has ${all.length} databases; pass a databaseId (${all
      .map((db) => `${db.id} "${db.title}"`)
      .join(', ')}).`,
  );
}

export function readDatabaseElement(element: Y.XmlElement): DatabaseData {
  return readDatabaseTree(element, yAdapter);
}

export function readDatabase(
  doc: Y.Doc,
  databaseId?: string,
  field = DEFAULT_FIELD,
): DatabaseData {
  return readDatabaseElement(resolveDatabase(doc, databaseId, field).element);
}

// ---------------------------------------------------------------- elements

function setAttrs(el: Y.XmlElement, attrs: Record<string, unknown>) {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) el.removeAttribute(key);
    else el.setAttribute(key, value as any);
  }
}

/** A Y element for ProseMirror JSON (element nodes only, as in our block). */
function jsonToYElement(json: any): Y.XmlElement {
  const el = new Y.XmlElement(json.type);
  setAttrs(el, json.attrs ?? {});
  const kids = (json.content ?? []).map(jsonToYElement);
  if (kids.length) el.insert(0, kids);
  return el;
}

function rowElements(db: Y.XmlElement): Y.XmlElement[] {
  return yAdapter.children(db).filter((c) => c.nodeName === DATABASE_ROW_NODE);
}

function columnElements(db: Y.XmlElement): Y.XmlElement[] {
  return yAdapter
    .children(db)
    .filter((c) => c.nodeName === DATABASE_COLUMN_NODE);
}

function columnElement(db: Y.XmlElement, columnId: string): Y.XmlElement {
  return columnElements(db).find((c) => c.getAttribute('id') === columnId);
}

function indexIn(parent: Y.XmlElement | Y.XmlFragment, child: Y.AbstractType<any>) {
  return children(parent).indexOf(child as any);
}

function transact(doc: Y.Doc, origin: unknown, fn: () => void) {
  doc.transact(fn, origin);
}

/** Sets the column's options to include `labels`, if any are new. */
function ensureOptions(
  db: Y.XmlElement,
  column: DatabaseColumn,
  labels: string[],
) {
  const options = optionsWith(column.options, labels);
  if (options !== column.options) {
    columnElement(db, column.id)?.setAttribute('options', options as any);
  }
}

/** Writes one cell: updates the row's (last) cell for the column, or adds one. */
function writeCell(row: Y.XmlElement, columnId: string, value: CellValue) {
  const cells = yAdapter
    .children(row)
    .filter(
      (c) =>
        c.nodeName === DATABASE_CELL_NODE && c.getAttribute('column') === columnId,
    );
  if (!cells.length) {
    if (value === null) return;
    const cell = new Y.XmlElement(DATABASE_CELL_NODE);
    setAttrs(cell, { column: columnId, value });
    row.insert(row.length, [cell]);
    return;
  }
  const keep = cells[cells.length - 1];
  for (const extra of cells.slice(0, -1).reverse()) {
    row.delete(indexIn(row, extra), 1);
  }
  setAttrs(keep, { value });
}

export interface MutationOptions {
  /** Yjs transaction origin (e.g. to tag MCP edits). */
  origin?: unknown;
  field?: string;
}

// ---------------------------------------------------------------- create

export interface CreateDatabaseOptions extends MutationOptions {
  /** Index among the fragment's top-level blocks; default: the end. */
  index?: number;
}

/** Inserts a new database block; returns its data (with the new ids). */
export function createDatabase(
  doc: Y.Doc,
  spec: DatabaseSpec,
  options: CreateDatabaseOptions = {},
): DatabaseData {
  const data = createDatabaseData(spec);
  const fragment = doc.getXmlFragment(options.field ?? DEFAULT_FIELD);
  const blocks = children(fragment);
  // The doc schema is `block+ footnotes?`: stay before a trailing footnotes.
  const last = blocks[blocks.length - 1];
  const end =
    last instanceof Y.XmlElement && last.nodeName === 'footnotes'
      ? blocks.length - 1
      : blocks.length;
  const index =
    options.index === undefined
      ? end
      : Math.max(0, Math.min(Math.floor(options.index), end));
  transact(doc, options.origin, () => {
    fragment.insert(index, [jsonToYElement(databaseToJson(data))]);
  });
  return data;
}

export function setDatabaseTitle(
  doc: Y.Doc,
  databaseId: string | undefined,
  title: string,
  options: MutationOptions = {},
) {
  const { element } = resolveDatabase(doc, databaseId, options.field);
  transact(doc, options.origin, () =>
    element.setAttribute('title', String(title ?? '').trim()),
  );
}

// ---------------------------------------------------------------- rows

export interface AddRowsOptions extends MutationOptions {
  /** Insert after this row; default: after the last row. */
  afterRowId?: string;
}

/** Appends rows given as `{columnKey: value}`; returns the new row ids. */
export function addRows(
  doc: Y.Doc,
  databaseId: string | undefined,
  rows: Record<string, CellInput>[],
  options: AddRowsOptions = {},
): string[] {
  const { element } = resolveDatabase(doc, databaseId, options.field);
  const data = readDatabaseElement(element);
  const encoded = rows.map((values) => encodeRowValues(data.columns, values));
  const existing = rowElements(element);
  let index = element.length;
  if (options.afterRowId !== undefined) {
    const after = existing.find((r) => r.getAttribute('id') === options.afterRowId);
    if (!after) throw new DatabaseError(`Row ${options.afterRowId} not found.`);
    index = indexIn(element, after) + 1;
  } else if (existing.length) {
    index = indexIn(element, existing[existing.length - 1]) + 1;
  }
  const ids = encoded.map(() => newDatabaseId());
  transact(doc, options.origin, () => {
    for (const column of data.columns) {
      ensureOptions(
        element,
        column,
        encoded.flatMap((e) => e.labels.get(column.id) ?? []),
      );
    }
    const elements = encoded.map(({ cells }, i) =>
      jsonToYElement({
        type: DATABASE_ROW_NODE,
        attrs: { id: ids[i] },
        content: data.columns
          .filter((c) => cells[c.id] !== undefined && cells[c.id] !== null)
          .map((c) => ({
            type: DATABASE_CELL_NODE,
            attrs: { column: c.id, value: cells[c.id] },
          })),
      }),
    );
    if (elements.length) element.insert(index, elements);
  });
  return ids;
}

export interface RowUpdate {
  id: string;
  /** `{columnKey: value}`; null clears a cell. Other cells are unchanged. */
  values: Record<string, CellInput>;
}

export function updateRows(
  doc: Y.Doc,
  databaseId: string | undefined,
  updates: RowUpdate[],
  options: MutationOptions = {},
) {
  const { element } = resolveDatabase(doc, databaseId, options.field);
  const data = readDatabaseElement(element);
  const rowsById = new Map<string, Y.XmlElement[]>();
  for (const row of rowElements(element)) {
    const id = String(row.getAttribute('id'));
    rowsById.set(id, [...(rowsById.get(id) ?? []), row]);
  }
  const encoded = updates.map((update) => {
    if (!rowsById.has(update.id)) {
      throw new DatabaseError(`Row ${update.id} not found.`);
    }
    return { id: update.id, ...encodeRowValues(data.columns, update.values) };
  });
  transact(doc, options.origin, () => {
    for (const column of data.columns) {
      ensureOptions(
        element,
        column,
        encoded.flatMap((e) => e.labels.get(column.id) ?? []),
      );
    }
    for (const { id, cells } of encoded) {
      for (const row of rowsById.get(id)) {
        for (const [columnId, value] of Object.entries(cells)) {
          writeCell(row, columnId, value);
        }
      }
    }
  });
}

/** Removes rows by id; returns how many were removed. */
export function removeRows(
  doc: Y.Doc,
  databaseId: string | undefined,
  rowIds: string[],
  options: MutationOptions = {},
): number {
  const { element } = resolveDatabase(doc, databaseId, options.field);
  const wanted = new Set(rowIds);
  const known = new Set(rowElements(element).map((r) => r.getAttribute('id')));
  const missing = rowIds.filter((id) => !known.has(id));
  if (missing.length) {
    throw new DatabaseError(`Rows not found: ${missing.join(', ')}.`);
  }
  const indices = children(element)
    .map((child, index) =>
      child instanceof Y.XmlElement &&
      child.nodeName === DATABASE_ROW_NODE &&
      wanted.has(String(child.getAttribute('id')))
        ? index
        : -1,
    )
    .filter((index) => index >= 0)
    .reverse();
  transact(doc, options.origin, () => {
    for (const index of indices) element.delete(index, 1);
  });
  return indices.length;
}

// ---------------------------------------------------------------- columns

function assertNameFree(columns: DatabaseColumn[], name: string, except?: string) {
  const key = name.trim().toLowerCase();
  if (!key) throw new DatabaseError('A column needs a name.');
  const clash = columns.find(
    (c) => c.id !== except && c.name.trim().toLowerCase() === key,
  );
  if (clash) throw new DatabaseError(`A column named "${clash.name}" exists.`);
}

export interface AddColumnOptions extends MutationOptions {
  /** Position among the columns; default: last. */
  index?: number;
}

export function addColumn(
  doc: Y.Doc,
  databaseId: string | undefined,
  spec: ColumnSpec,
  options: AddColumnOptions = {},
): DatabaseColumn {
  const { element } = resolveDatabase(doc, databaseId, options.field);
  const data = readDatabaseElement(element);
  if (spec?.type === 'title') {
    throw new DatabaseError('A database has exactly one title column.');
  }
  const column = newColumn(spec);
  assertNameFree(data.columns, column.name);
  const columns = columnElements(element);
  const position =
    options.index === undefined
      ? columns.length
      : Math.max(0, Math.min(Math.floor(options.index), columns.length));
  const index =
    position < columns.length
      ? indexIn(element, columns[position])
      : columns.length
        ? indexIn(element, columns[columns.length - 1]) + 1
        : 0;
  transact(doc, options.origin, () => {
    element.insert(index, [
      jsonToYElement({ type: DATABASE_COLUMN_NODE, attrs: columnAttrs(column) }),
    ]);
  });
  return column;
}

export function renameColumn(
  doc: Y.Doc,
  databaseId: string | undefined,
  columnKey: string,
  name: string,
  options: MutationOptions = {},
): DatabaseColumn {
  const { element } = resolveDatabase(doc, databaseId, options.field);
  const data = readDatabaseElement(element);
  const column = resolveColumn(data.columns, columnKey);
  const next = String(name ?? '').trim();
  assertNameFree(data.columns, next, column.id);
  transact(doc, options.origin, () =>
    columnElement(element, column.id).setAttribute('name', next),
  );
  return { ...column, name: next };
}

/** Removes a column and its cells. The title column cannot be removed. */
export function removeColumn(
  doc: Y.Doc,
  databaseId: string | undefined,
  columnKey: string,
  options: MutationOptions = {},
) {
  const { element } = resolveDatabase(doc, databaseId, options.field);
  const data = readDatabaseElement(element);
  const column = resolveColumn(data.columns, columnKey);
  if (column.type === 'title') {
    throw new DatabaseError('The title column cannot be removed.');
  }
  transact(doc, options.origin, () => {
    for (const row of rowElements(element)) {
      const cells = children(row);
      for (let i = cells.length - 1; i >= 0; i--) {
        const cell = cells[i];
        if (cell instanceof Y.XmlElement && cell.getAttribute('column') === column.id) {
          row.delete(i, 1);
        }
      }
    }
    for (const col of columnElements(element).reverse()) {
      if (col.getAttribute('id') === column.id) {
        element.delete(indexIn(element, col), 1);
      }
    }
  });
}

/**
 * Changes a column's type and converts every value (a value that does not
 * fit becomes empty). Select options are kept, or built from the values.
 */
export function retypeColumn(
  doc: Y.Doc,
  databaseId: string | undefined,
  columnKey: string,
  type: ColumnType,
  options: MutationOptions = {},
): DatabaseColumn {
  const { element } = resolveDatabase(doc, databaseId, options.field);
  const data = readDatabaseElement(element);
  const column = resolveColumn(data.columns, columnKey);
  if (!isColumnType(type)) throw new DatabaseError(`Unknown column type "${type}".`);
  if (column.type === 'title' || type === 'title') {
    throw new DatabaseError('The title column cannot be retyped.');
  }
  if (column.type === type) return column;
  const selectable = type === 'select' || type === 'multi-select';
  const target: DatabaseColumn = {
    ...column,
    type,
    options: selectable ? column.options : [],
  };
  const converted = data.rows.map((row) =>
    convertValue(column, target, row.cells[column.id] ?? null),
  );
  const result: DatabaseColumn = {
    ...target,
    options: selectable
      ? optionsWith(target.options, converted.flatMap(valueLabels))
      : [],
  };
  transact(doc, options.origin, () => {
    setAttrs(columnElement(element, column.id), {
      type,
      options: result.options,
    });
    rowElements(element).forEach((row, i) => {
      const before = data.rows[i]?.cells[column.id] ?? null;
      if (before === null && converted[i] === null) return;
      writeCell(row, column.id, converted[i]);
    });
  });
  return result;
}

/**
 * Replaces a select column's options. `renames` maps old label -> new label
 * and rewrites the cells; values whose label is dropped stay as they are
 * (they show as unknown options) unless `clearRemoved` is set.
 */
export function setColumnOptions(
  doc: Y.Doc,
  databaseId: string | undefined,
  columnKey: string,
  next: (string | SelectOption)[],
  opts: MutationOptions & {
    renames?: Record<string, string>;
    clearRemoved?: boolean;
  } = {},
): DatabaseColumn {
  const { element } = resolveDatabase(doc, databaseId, opts.field);
  const data = readDatabaseElement(element);
  const column = resolveColumn(data.columns, columnKey);
  if (column.type !== 'select' && column.type !== 'multi-select') {
    throw new DatabaseError(`Column "${column.name}" has no options.`);
  }
  const options = readOptions(next);
  const kept = new Set(options.map((o) => o.label));
  const renames = opts.renames ?? {};
  const mapLabel = (label: string) => {
    const renamed = renames[label] ?? label;
    return kept.has(renamed) || !opts.clearRemoved ? renamed : null;
  };
  transact(doc, opts.origin, () => {
    columnElement(element, column.id).setAttribute('options', options as any);
    rowElements(element).forEach((row, i) => {
      const value = data.rows[i]?.cells[column.id] ?? null;
      if (value === null) return;
      const labels = valueLabels(value).map(mapLabel).filter(Boolean);
      const updated =
        column.type === 'select'
          ? (labels[0] ?? null)
          : labels.length
            ? [...new Set(labels)]
            : null;
      if (JSON.stringify(updated) !== JSON.stringify(value)) {
        writeCell(row, column.id, updated);
      }
    });
  });
  return { ...column, options };
}
