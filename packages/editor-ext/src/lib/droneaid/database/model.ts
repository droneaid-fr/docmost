import { generateNodeId } from "../../utils";
import {
  CellInput,
  CellValue,
  ColumnType,
  DATABASE_CELL_NODE,
  DATABASE_COLUMN_NODE,
  DATABASE_NODE,
  DATABASE_ROW_NODE,
  DatabaseColumn,
  DatabaseData,
  DatabaseError,
  DatabaseRow,
  SelectOption,
} from "./types";
import {
  cellText,
  isColumnType,
  optionsWith,
  readCellValue,
  readOptions,
  toCellValue,
  valueLabels,
} from "./values";

/**
 * Typed reads of the database tree, whichever form it is in (ProseMirror
 * JSON, a ProseMirror node, a Y.XmlElement), and builders for new data.
 */

export function newDatabaseId(): string {
  return generateNodeId();
}

/** Minimal read access to a tree node; one adapter per representation. */
export interface TreeAdapter<T> {
  type(node: T): string;
  attrs(node: T): Record<string, unknown>;
  children(node: T): T[];
}

export function readColumnAttrs(attrs: Record<string, unknown>): DatabaseColumn {
  const type = isColumnType(attrs.type) ? attrs.type : "text";
  const width = Number(attrs.width);
  return {
    id: String(attrs.id ?? ""),
    name: typeof attrs.name === "string" ? attrs.name : "",
    type,
    options:
      type === "select" || type === "multi-select"
        ? readOptions(attrs.options)
        : [],
    width: Number.isFinite(width) && width > 0 ? width : null,
  };
}

/**
 * The typed database. Columns and rows are read by node type in document
 * order (they may interleave after concurrent inserts). A cell for an
 * unknown column is ignored; of two cells for one column, the last wins.
 */
export function readDatabaseTree<T>(
  root: T,
  adapter: TreeAdapter<T>,
): DatabaseData {
  const attrs = adapter.attrs(root);
  const columns: DatabaseColumn[] = [];
  const byId = new Map<string, DatabaseColumn>();
  const rowNodes: T[] = [];
  for (const child of adapter.children(root)) {
    const type = adapter.type(child);
    if (type === DATABASE_COLUMN_NODE) {
      const column = readColumnAttrs(adapter.attrs(child));
      if (!column.id || byId.has(column.id)) continue;
      byId.set(column.id, column);
      columns.push(column);
    } else if (type === DATABASE_ROW_NODE) {
      rowNodes.push(child);
    }
  }
  const rows: DatabaseRow[] = rowNodes.map((rowNode) => {
    const cells: Record<string, CellValue> = {};
    for (const cell of adapter.children(rowNode)) {
      if (adapter.type(cell) !== DATABASE_CELL_NODE) continue;
      const cellAttrs = adapter.attrs(cell);
      const column = byId.get(String(cellAttrs.column ?? ""));
      if (!column) continue;
      const value = readCellValue(column, cellAttrs.value);
      if (value === null) delete cells[column.id];
      else cells[column.id] = value;
    }
    return { id: String(adapter.attrs(rowNode).id ?? ""), cells };
  });
  return {
    id: String(attrs.id ?? ""),
    title: typeof attrs.title === "string" ? attrs.title : "",
    columns,
    rows,
  };
}

/** ProseMirror JSON (`{type, attrs, content}`). */
export const jsonAdapter: TreeAdapter<any> = {
  type: (node) => node?.type ?? "",
  attrs: (node) => node?.attrs ?? {},
  children: (node) => (Array.isArray(node?.content) ? node.content : []),
};

/** A ProseMirror `Node` (structural typing, so no prosemirror import). */
export const pmNodeAdapter: TreeAdapter<any> = {
  type: (node) => node.type.name,
  attrs: (node) => node.attrs,
  children: (node) => {
    const list: any[] = [];
    node.forEach((child: any) => list.push(child));
    return list;
  },
};

export function readDatabaseJson(json: unknown): DatabaseData {
  return readDatabaseTree(json, jsonAdapter);
}

export function readDatabaseNode(node: unknown): DatabaseData {
  return readDatabaseTree(node, pmNodeAdapter);
}

/** Every database node in a ProseMirror JSON doc, in document order. */
export function findDatabasesInJson(doc: unknown): DatabaseData[] {
  const found: DatabaseData[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (node.type === DATABASE_NODE) {
      found.push(readDatabaseJson(node));
      return;
    }
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(doc);
  return found;
}

// ---------------------------------------------------------------- JSON out

export function columnAttrs(column: DatabaseColumn): Record<string, unknown> {
  return {
    id: column.id,
    name: column.name,
    type: column.type,
    options: column.options.map((o) => ({ label: o.label, color: o.color })),
    width: column.width,
  };
}

export function cellJson(columnId: string, value: CellValue) {
  return { type: DATABASE_CELL_NODE, attrs: { column: columnId, value } };
}

export function rowJson(row: DatabaseRow, columns: DatabaseColumn[]) {
  const content = columns
    .filter((c) => row.cells[c.id] !== undefined && row.cells[c.id] !== null)
    .map((c) => cellJson(c.id, row.cells[c.id]));
  return {
    type: DATABASE_ROW_NODE,
    attrs: { id: row.id },
    ...(content.length ? { content } : {}),
  };
}

/** ProseMirror JSON for a database: columns first, then rows. */
export function databaseToJson(data: DatabaseData) {
  return {
    type: DATABASE_NODE,
    attrs: { id: data.id, title: data.title },
    content: [
      ...data.columns.map((c) => ({
        type: DATABASE_COLUMN_NODE,
        attrs: columnAttrs(c),
      })),
      ...data.rows.map((r) => rowJson(r, data.columns)),
    ],
  };
}

// ---------------------------------------------------------------- lookup

export function titleColumn(columns: DatabaseColumn[]): DatabaseColumn | undefined {
  return columns.find((c) => c.type === "title") ?? columns[0];
}

/** A column by id, exact name, or case-insensitive name; never ambiguous. */
export function resolveColumn(
  columns: DatabaseColumn[],
  key: string,
): DatabaseColumn {
  const byId = columns.find((c) => c.id === key);
  if (byId) return byId;
  for (const match of [
    (c: DatabaseColumn) => c.name === key,
    (c: DatabaseColumn) => c.name.trim().toLowerCase() === key.trim().toLowerCase(),
  ]) {
    const found = columns.filter(match);
    if (found.length === 1) return found[0];
    if (found.length > 1) {
      throw new DatabaseError(
        `Several columns are named "${key}"; use the column id (${found
          .map((c) => c.id)
          .join(", ")}).`,
      );
    }
  }
  throw new DatabaseError(
    `Unknown column "${key}". Columns: ${columns.map((c) => c.name).join(", ")}.`,
  );
}

/** Keys rows are reported under: the column name, or its id if names clash. */
export function columnKeys(columns: DatabaseColumn[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const c of columns) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  return new Map(
    columns.map((c) => [
      c.id,
      (counts.get(c.name) ?? 0) > 1 || !c.name ? c.id : c.name,
    ]),
  );
}

/**
 * Converts `{columnKey: input}` into `{columnId: value}` (validated, strict).
 * Also returns the select labels each column would need as new options.
 */
export function encodeRowValues(
  columns: DatabaseColumn[],
  values: Record<string, CellInput>,
): { cells: Record<string, CellValue>; labels: Map<string, string[]> } {
  const cells: Record<string, CellValue> = {};
  const labels = new Map<string, string[]>();
  for (const [key, input] of Object.entries(values ?? {})) {
    const column = resolveColumn(columns, key);
    const value = toCellValue(column, input);
    cells[column.id] = value;
    if (column.type === "select" || column.type === "multi-select") {
      labels.set(column.id, [
        ...(labels.get(column.id) ?? []),
        ...valueLabels(value),
      ]);
    }
  }
  return { cells, labels };
}

// ---------------------------------------------------------------- creation

export interface ColumnSpec {
  name: string;
  type: ColumnType;
  /** Labels or full options; select and multi-select only. */
  options?: (string | SelectOption)[];
  width?: number | null;
}

export function newColumn(spec: ColumnSpec): DatabaseColumn {
  if (!isColumnType(spec?.type)) {
    throw new DatabaseError(`Unknown column type "${spec?.type}".`);
  }
  const name = String(spec.name ?? "").trim();
  if (!name) throw new DatabaseError("A column needs a name.");
  const selectable = spec.type === "select" || spec.type === "multi-select";
  return {
    id: newDatabaseId(),
    name,
    type: spec.type,
    options: selectable ? readOptions(spec.options ?? []) : [],
    width: spec.width ?? null,
  };
}

export interface DatabaseSpec {
  title?: string;
  /** If none is of type "title", a "Name" title column is put first. */
  columns?: ColumnSpec[];
  rows?: Record<string, CellInput>[];
}

/** A new, validated database with fresh ids. */
export function createDatabaseData(spec: DatabaseSpec = {}): DatabaseData {
  const specs = spec.columns?.length ? spec.columns : [];
  const titles = specs.filter((c) => c.type === "title").length;
  if (titles > 1) throw new DatabaseError("A database has one title column.");
  const columns = [
    ...(titles ? [] : [newColumn({ name: "Name", type: "title" })]),
    ...specs.map(newColumn),
  ];
  const names = new Set<string>();
  for (const c of columns) {
    const key = c.name.toLowerCase();
    if (names.has(key)) throw new DatabaseError(`Duplicate column "${c.name}".`);
    names.add(key);
  }
  const used = new Map<string, string[]>();
  const rows = (spec.rows ?? []).map((values) => {
    const { cells, labels } = encodeRowValues(columns, values);
    for (const [columnId, list] of labels) {
      used.set(columnId, [...(used.get(columnId) ?? []), ...list]);
    }
    const stored = Object.fromEntries(
      Object.entries(cells).filter(([, value]) => value !== null),
    );
    return { id: newDatabaseId(), cells: stored };
  });
  return {
    id: newDatabaseId(),
    title: String(spec.title ?? "").trim(),
    columns: columns.map((c) =>
      used.has(c.id) ? { ...c, options: optionsWith(c.options, used.get(c.id)) } : c,
    ),
    rows,
  };
}

// ---------------------------------------------------------------- reading rows

export interface RowQuery {
  offset?: number;
  limit?: number;
  /** Case-insensitive substring over every cell's text. */
  search?: string;
}

export interface RowPage {
  total: number;
  matched: number;
  offset: number;
  rows: { id: string; index: number; values: Record<string, CellValue> }[];
}

/** Rows keyed by column name (see columnKeys), filtered and paged. */
export function queryRows(data: DatabaseData, query: RowQuery = {}): RowPage {
  const keys = columnKeys(data.columns);
  const needle = query.search?.trim().toLowerCase();
  const matching = data.rows
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row }) =>
        !needle ||
        data.columns.some((c) =>
          cellText(row.cells[c.id] ?? null).toLowerCase().includes(needle),
        ),
    );
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const limit = Math.max(0, Math.floor(query.limit ?? 50));
  return {
    total: data.rows.length,
    matched: matching.length,
    offset,
    rows: matching.slice(offset, offset + limit).map(({ row, index }) => ({
      id: row.id,
      index,
      values: Object.fromEntries(
        data.columns.map((c) => [keys.get(c.id), row.cells[c.id] ?? null]),
      ),
    })),
  };
}

/** Plain text of the database, one row per line (search, text content). */
export function databaseText(data: DatabaseData): string {
  const lines = [
    data.title,
    data.columns.map((c) => c.name).join(" | "),
    ...data.rows.map((row) =>
      data.columns.map((c) => cellText(row.cells[c.id] ?? null)).join(" | "),
    ),
  ];
  return lines.filter((line) => line.trim()).join("\n");
}

/** The data with every select label that rows use present in its column's options. */
export function withUsedOptions(data: DatabaseData): DatabaseData {
  const columns = data.columns.map((column) => {
    if (column.type !== "select" && column.type !== "multi-select") return column;
    const used = data.rows.flatMap((row) => valueLabels(row.cells[column.id] ?? null));
    const options = optionsWith(column.options, used);
    return options === column.options ? column : { ...column, options };
  });
  return { ...data, columns };
}
