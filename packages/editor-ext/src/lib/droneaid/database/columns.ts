import {
  CellValue,
  ColumnType,
  DATABASE_CELL_NODE,
  DATABASE_COLUMN_NODE,
  DATABASE_NODE,
  DATABASE_ROW_NODE,
  DatabaseColumn,
  DatabaseError,
  SelectOption,
} from "./types";
import { cellText, convertValue, optionsWith, valueLabels } from "./values";
import { newDatabaseId } from "./model";

/** Pure planning of column changes, shared by the client view and tests. */

export interface RetypePlan {
  column: DatabaseColumn;
  /** New value per input value, same order. */
  values: CellValue[];
  /** Values that change their text or become empty. */
  changed: number;
  /** Values that become empty. */
  cleared: number;
}

/**
 * Converts a column's values to `type` (a value that does not fit becomes
 * empty) and reports how lossy that is. Select options are kept, or built
 * from the converted labels. The title column cannot be retyped.
 */
export function planRetype(
  column: DatabaseColumn,
  type: ColumnType,
  values: CellValue[],
): RetypePlan {
  if (column.type === "title" || type === "title") {
    throw new DatabaseError("The title column cannot be retyped.");
  }
  const selectable = type === "select" || type === "multi-select";
  const target: DatabaseColumn = {
    ...column,
    type,
    options: selectable ? column.options : [],
  };
  const converted = values.map((v) => convertValue(column, target, v));
  let changed = 0;
  let cleared = 0;
  values.forEach((before, i) => {
    if (before === null) return;
    const after = converted[i];
    if (after === null) cleared++;
    if (after === null || cellText(after) !== cellText(before)) changed++;
  });
  return {
    column: {
      ...target,
      options: selectable ? optionsWith(target.options, converted.flatMap(valueLabels)) : [],
    },
    values: converted,
    changed,
    cleared,
  };
}

/**
 * A select value with labels renamed (`renames`: old -> new) and labels in
 * `removed` dropped. Returns the same value when nothing changes.
 */
export function relabelValue(
  column: DatabaseColumn,
  value: CellValue,
  renames: Record<string, string>,
  removed: Set<string> = new Set(),
): CellValue {
  const labels = valueLabels(value);
  if (!labels.length) return value;
  if (!labels.some((l) => l in renames || removed.has(l))) return value;
  const next = [
    ...new Set(
      labels.map((l) => renames[l] ?? l).filter((l) => !removed.has(l)),
    ),
  ];
  if (column.type === "select") return next[0] ?? null;
  return next.length ? next : null;
}

/** Validates an option rename; returns the trimmed new label. */
export function checkOptionRename(
  options: SelectOption[],
  from: string,
  to: string,
): string {
  const label = to.trim();
  if (!label) throw new DatabaseError("An option needs a label.");
  if (label !== from && options.some((o) => o.label === label)) {
    throw new DatabaseError(`An option "${label}" already exists.`);
  }
  return label;
}

/** A column name not yet used (case-insensitive): "Column", "Column 2", ... */
export function uniqueColumnName(columns: DatabaseColumn[], base: string): string {
  const used = new Set(columns.map((c) => c.name.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

/**
 * A copy of a database's ProseMirror JSON with fresh database, column and
 * row ids; cells follow their column's new id. Used when a database is
 * pasted or duplicated inside a page, so the copy is a separate database.
 */
export function reidDatabaseJson(json: any): any {
  if (!json || json.type !== DATABASE_NODE) return json;
  const columnIds = new Map<string, string>();
  for (const child of json.content ?? []) {
    if (child?.type === DATABASE_COLUMN_NODE) {
      const old = String(child.attrs?.id ?? "");
      if (!columnIds.has(old)) columnIds.set(old, newDatabaseId());
    }
  }
  const content = (json.content ?? []).map((child: any) => {
    if (child?.type === DATABASE_COLUMN_NODE) {
      return {
        ...child,
        attrs: { ...child.attrs, id: columnIds.get(String(child.attrs?.id ?? "")) },
      };
    }
    if (child?.type === DATABASE_ROW_NODE) {
      return {
        ...child,
        attrs: { ...child.attrs, id: newDatabaseId() },
        ...(child.content
          ? {
              content: child.content.map((cell: any) =>
                cell?.type === DATABASE_CELL_NODE
                  ? {
                      ...cell,
                      attrs: {
                        ...cell.attrs,
                        column:
                          columnIds.get(String(cell.attrs?.column ?? "")) ??
                          cell.attrs?.column,
                      },
                    }
                  : cell,
              ),
            }
          : {}),
      };
    }
    return child;
  });
  const view = json.attrs?.view;
  const remap = (id: string) => columnIds.get(id) ?? id;
  const nextView =
    view && typeof view === "object"
      ? {
          ...view,
          sorts: Array.isArray(view.sorts)
            ? view.sorts.map((s: any) => ({ ...s, column: remap(String(s?.column)) }))
            : [],
          filters: Array.isArray(view.filters)
            ? view.filters.map((f: any) => ({ ...f, column: remap(String(f?.column)) }))
            : [],
        }
      : view;
  return {
    ...json,
    attrs: { ...json.attrs, id: newDatabaseId(), ...(view ? { view: nextView } : {}) },
    content,
  };
}
