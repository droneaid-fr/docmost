/**
 * The database block's data model. See droneaid/docs/adr-0001-database-block.md.
 *
 * Storage is ProseMirror nodes (one leaf node per cell), so concurrent edits to
 * different cells, rows and columns merge in Yjs. These types are the typed
 * view of that tree, shared by the client view, the server and MCP.
 */

export const DATABASE_NODE = "droneaidDatabase";
export const DATABASE_COLUMN_NODE = "droneaidDatabaseColumn";
export const DATABASE_ROW_NODE = "droneaidDatabaseRow";
export const DATABASE_CELL_NODE = "droneaidDatabaseCell";

export const COLUMN_TYPES = [
  "title",
  "text",
  "number",
  "select",
  "multi-select",
  "date",
  "checkbox",
  "link",
] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export const OPTION_COLORS = [
  "gray",
  "blue",
  "green",
  "yellow",
  "orange",
  "red",
  "pink",
  "violet",
  "teal",
] as const;
export type OptionColor = (typeof OPTION_COLORS)[number];

export interface SelectOption {
  label: string;
  color: OptionColor;
}

export interface DatabaseColumn {
  id: string;
  name: string;
  type: ColumnType;
  /** Select and multi-select only; empty for other types. */
  options: SelectOption[];
  /** Display width in px, or null for the default. */
  width: number | null;
}

/**
 * A stored cell value. `null` is empty.
 * title/text/link: string; number: number; select: label; multi-select:
 * labels; date: "YYYY-MM-DD"; checkbox: true.
 */
export type CellValue = string | number | boolean | string[] | null;

export interface DatabaseRow {
  id: string;
  /** Column id -> value. Columns with no stored value are absent. */
  cells: Record<string, CellValue>;
}

export interface DatabaseData {
  id: string;
  title: string;
  columns: DatabaseColumn[];
  rows: DatabaseRow[];
}

/** What a caller may pass as a cell value; converted per column type. */
export type CellInput = string | number | boolean | string[] | null | undefined;

export class DatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseError";
  }
}
