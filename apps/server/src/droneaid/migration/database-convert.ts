import {
  CellValue,
  ColumnType,
  DatabaseColumn,
  DatabaseData,
  OPTION_COLORS,
  OptionColor,
  SelectOption,
  optionsWith,
  toCellValue,
} from '@docmost/editor-ext';
import type { BundleDatabase, BundleDatabaseColumn } from './bundle';

/**
 * AFFiNE database (bundle `databases/<id>.json`) -> our database block data
 * (S4a model), pure. Database, column and row ids are kept when they are
 * non-empty and unique; otherwise a fresh id is used and reported.
 */

export const COLUMN_TYPE_MAP: Record<string, ColumnType> = {
  title: 'title',
  'rich-text': 'text',
  text: 'text',
  number: 'number',
  select: 'select',
  'multi-select': 'multi-select',
  date: 'date',
  checkbox: 'checkbox',
  link: 'link',
  // AFFiNE member cells hold user ids; we store the people's names as text.
  member: 'text',
};

/** `var(--affine-v2-chip-label-blue)` -> blue. */
export function optionColor(affineColor: unknown, fallbackIndex: number): OptionColor {
  const text = String(affineColor ?? '').toLowerCase();
  const name = /(white|gray|grey|blue|green|yellow|orange|red|pink|purple|violet|teal)/.exec(text)?.[1];
  const mapped: Record<string, OptionColor> = {
    white: 'gray',
    gray: 'gray',
    grey: 'gray',
    blue: 'blue',
    green: 'green',
    yellow: 'yellow',
    orange: 'orange',
    red: 'red',
    pink: 'pink',
    purple: 'violet',
    violet: 'violet',
    teal: 'teal',
  };
  return (name && mapped[name]) || OPTION_COLORS[fallbackIndex % OPTION_COLORS.length];
}

export type DatabaseConversion = {
  data: DatabaseData;
  /** Column ids, row ids or the database id that had to be replaced. */
  renamedIds: string[];
  /** Cells whose value did not fit the column type (stored empty). */
  invalidCells: { rowId: string; column: string; value: unknown }[];
  /** Formatted text cells kept as plain text. */
  richTextCells: number;
  hiddenColumns: string[];
  notes: string[];
};

function tableWidths(views: any[]): Map<string, { width: number | null; hide: boolean }> {
  const table = (views ?? []).find((v) => v?.mode === 'table') ?? (views ?? [])[0];
  const map = new Map<string, { width: number | null; hide: boolean }>();
  for (const c of table?.columns ?? []) {
    const width = Number(c?.width);
    map.set(String(c?.id), {
      width: Number.isFinite(width) && width > 0 ? width : null,
      hide: c?.hide === true,
    });
  }
  return map;
}

function affineOptions(column: BundleDatabaseColumn): SelectOption[] {
  const raw: any[] = column.data?.options ?? [];
  const seen = new Set<string>();
  const out: SelectOption[] = [];
  raw.forEach((option, i) => {
    const label = String(option?.value ?? '').trim();
    if (!label || seen.has(label)) return;
    seen.add(label);
    out.push({ label, color: optionColor(option?.color, i) });
  });
  return out;
}

/** Member cell (JSON list of user ids, or a list) -> people's names. */
function memberText(value: unknown, people: Map<string, string>): string | null {
  let ids: unknown = value;
  if (typeof value === 'string') {
    try {
      ids = JSON.parse(value);
    } catch {
      ids = value ? [value] : [];
    }
  }
  const list = Array.isArray(ids) ? ids : [];
  const names = list.map((id) => people.get(String(id)) ?? String(id)).filter(Boolean);
  return names.length ? names.join(', ') : null;
}

export function convertDatabase(
  source: BundleDatabase,
  opts: {
    /** AFFiNE user id -> display name (for member columns). */
    people?: Map<string, string>;
    /** Ids already used in the target (database ids are global per doc). */
    usedDatabaseIds?: Set<string>;
    freshId: () => string;
  },
): DatabaseConversion {
  const renamedIds: string[] = [];
  const notes: string[] = [];
  const widths = tableWidths(source.views);
  const used = new Set<string>();
  const keepId = (id: unknown, scope: Set<string>): string => {
    const value = typeof id === 'string' ? id.trim() : '';
    if (value && !scope.has(value)) {
      scope.add(value);
      return value;
    }
    const fresh = opts.freshId();
    scope.add(fresh);
    renamedIds.push(value || '(empty)');
    return fresh;
  };

  const dbScope = opts.usedDatabaseIds ?? new Set<string>();
  const id = keepId(source.databaseId, dbScope);

  const hiddenColumns: string[] = [];
  let hasTitle = false;
  const columns: { column: DatabaseColumn; source: BundleDatabaseColumn }[] = [];
  for (const col of source.columns) {
    let type = COLUMN_TYPE_MAP[col.type];
    if (!type) {
      notes.push(`column "${col.name}" of AFFiNE type ${col.type} stored as text`);
      type = 'text';
    }
    if (type === 'title') {
      if (hasTitle) type = 'text';
      hasTitle = true;
    }
    const layout = widths.get(col.id);
    if (layout?.hide) hiddenColumns.push(col.name);
    columns.push({
      source: col,
      column: {
        id: keepId(col.id, used),
        name: col.name || (type === 'title' ? 'Title' : 'Column'),
        type,
        options: type === 'select' || type === 'multi-select' ? affineOptions(col) : [],
        width: layout?.width ?? null,
      },
    });
  }

  const invalidCells: DatabaseConversion['invalidCells'] = [];
  const usedLabels = new Map<string, string[]>();
  const rowIds = new Set<string>();
  let richTextCells = 0;
  const rows = source.rows.map((row) => {
    if (row.richText) richTextCells += Object.keys(row.richText).length;
    const cells: Record<string, CellValue> = {};
    for (const { column, source: col } of columns) {
      let raw: unknown = row.values?.[col.id];
      if (col.type === 'member') raw = memberText(raw, opts.people ?? new Map());
      if (raw === undefined || raw === null || raw === '') continue;
      let value: CellValue;
      try {
        value = toCellValue(column, raw as any);
      } catch {
        value = toCellValue(column, raw as any, true);
        invalidCells.push({ rowId: row.id, column: column.name, value: raw });
      }
      if (value === null) continue;
      cells[column.id] = value;
      if (column.type === 'select' || column.type === 'multi-select') {
        const labels = Array.isArray(value) ? value.map(String) : [String(value)];
        usedLabels.set(column.id, [...(usedLabels.get(column.id) ?? []), ...labels]);
      }
    }
    return { id: keepId(row.id, rowIds), cells };
  });

  return {
    data: {
      id,
      title: source.title ?? '',
      columns: columns.map(({ column }) =>
        usedLabels.has(column.id)
          ? { ...column, options: optionsWith(column.options, usedLabels.get(column.id)) }
          : column,
      ),
      rows,
    },
    renamedIds,
    invalidCells,
    richTextCells,
    hiddenColumns,
    notes,
  };
}

/** Bundle value vs stored value, for the dry-run comparison. Pure. */
export function sameCell(bundleValue: unknown, stored: unknown): boolean {
  const empty = (v: unknown) =>
    v === null || v === undefined || v === '' || v === false || (Array.isArray(v) && !v.length);
  if (empty(bundleValue) && empty(stored)) return true;
  if (Array.isArray(bundleValue) || Array.isArray(stored)) {
    const a = (Array.isArray(bundleValue) ? bundleValue : [bundleValue]).map(String);
    const b = (Array.isArray(stored) ? stored : [stored]).map(String);
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }
  if (typeof bundleValue === 'number' || typeof stored === 'number') {
    return Number(bundleValue) === Number(stored);
  }
  return String(bundleValue).trim() === String(stored).trim();
}
