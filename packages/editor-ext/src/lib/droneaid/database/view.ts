import { CellValue, ColumnType, DatabaseColumn, DatabaseRow } from "./types";
import { cellText, isEmptyValue, toIsoDate, valueLabels } from "./values";

/**
 * View state of a database: sort keys and filters. It is stored as one
 * attribute (`view`) on the database node, so it is shared and persisted;
 * concurrent changes to it are last-writer-wins (adr-0001). Rules that name
 * a missing column, or an operator the column's type does not support, are
 * kept but ignored, so a retyped or deleted column never breaks a view.
 */

export type SortDirection = "asc" | "desc";

export interface SortRule {
  column: string;
  direction: SortDirection;
}

export const FILTER_OPS = [
  "contains",
  "not-contains",
  "is",
  "is-not",
  "is-any-of",
  "is-none-of",
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "before",
  "after",
  "on",
  "is-empty",
  "is-not-empty",
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** Filter operand: text, number, date ("YYYY-MM-DD"), labels or checked. */
export type FilterValue = string | number | boolean | string[] | null;

export interface FilterRule {
  id: string;
  column: string;
  op: FilterOp;
  value: FilterValue;
}

export interface DatabaseViewState {
  sorts: SortRule[];
  filters: FilterRule[];
}

export const EMPTY_VIEW: DatabaseViewState = Object.freeze({
  sorts: [],
  filters: [],
}) as DatabaseViewState;

const MAX_RULES = 20;

/** Operators offered per column type; the first is the default. */
export const FILTER_OPS_BY_TYPE: Record<ColumnType, FilterOp[]> = {
  title: ["contains", "not-contains", "is", "is-not", "is-empty", "is-not-empty"],
  text: ["contains", "not-contains", "is", "is-not", "is-empty", "is-not-empty"],
  link: ["contains", "not-contains", "is", "is-not", "is-empty", "is-not-empty"],
  number: ["eq", "neq", "lt", "lte", "gt", "gte", "is-empty", "is-not-empty"],
  select: ["is", "is-not", "is-any-of", "is-none-of", "is-empty", "is-not-empty"],
  "multi-select": ["is-any-of", "is-none-of", "is-empty", "is-not-empty"],
  date: ["on", "before", "after", "is-empty", "is-not-empty"],
  checkbox: ["is"],
};

export function isFilterOp(op: unknown): op is FilterOp {
  return FILTER_OPS.includes(op as FilterOp);
}

/** Whether an operator needs an operand. */
export function opNeedsValue(op: FilterOp): boolean {
  return op !== "is-empty" && op !== "is-not-empty";
}

function readFilterValue(raw: unknown): FilterValue {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" || typeof raw === "boolean") return raw;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (Array.isArray(raw)) return raw.filter((x) => typeof x === "string");
  return null;
}

/** The view as stored, cleaned (stored data may be anything). */
export function readView(raw: unknown): DatabaseViewState {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return EMPTY_VIEW;
    }
  }
  if (!value || typeof value !== "object") return EMPTY_VIEW;
  const obj = value as Record<string, unknown>;
  const sorts: SortRule[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(obj.sorts) ? obj.sorts : []) {
    const column = typeof item?.column === "string" ? item.column : "";
    if (!column || seen.has(column)) continue;
    seen.add(column);
    sorts.push({ column, direction: item.direction === "desc" ? "desc" : "asc" });
  }
  const filters: FilterRule[] = [];
  const ids = new Set<string>();
  (Array.isArray(obj.filters) ? obj.filters : []).forEach((item: any, i: number) => {
    const column = typeof item?.column === "string" ? item.column : "";
    if (!column || !isFilterOp(item?.op)) return;
    let id = typeof item.id === "string" && item.id ? item.id : `f${i}`;
    while (ids.has(id)) id = `${id}_`;
    ids.add(id);
    filters.push({ id, column, op: item.op, value: readFilterValue(item.value) });
  });
  if (!sorts.length && !filters.length) return EMPTY_VIEW;
  return { sorts: sorts.slice(0, MAX_RULES), filters: filters.slice(0, MAX_RULES) };
}

export function isEmptyView(view: DatabaseViewState): boolean {
  return !view.sorts.length && !view.filters.length;
}

/** The view without rules for `columnId` (when the column is deleted). */
export function viewWithoutColumn(
  view: DatabaseViewState,
  columnId: string,
): DatabaseViewState {
  return {
    sorts: view.sorts.filter((s) => s.column !== columnId),
    filters: view.filters.filter((f) => f.column !== columnId),
  };
}

/** The view after a column changed type: its filters no longer apply. */
export function viewForRetype(
  view: DatabaseViewState,
  columnId: string,
): DatabaseViewState {
  return { ...view, filters: view.filters.filter((f) => f.column !== columnId) };
}

/** The view with select labels renamed in filter operands. */
export function viewWithRenamedLabel(
  view: DatabaseViewState,
  columnId: string,
  from: string,
  to: string,
): DatabaseViewState {
  let changed = false;
  const filters = view.filters.map((f) => {
    if (f.column !== columnId) return f;
    if (f.value === from) {
      changed = true;
      return { ...f, value: to };
    }
    if (Array.isArray(f.value) && f.value.includes(from)) {
      changed = true;
      return { ...f, value: [...new Set(f.value.map((l) => (l === from ? to : l)))] };
    }
    return f;
  });
  return changed ? { ...view, filters } : view;
}

/** A rule is active when its column exists, supports the op and has an operand. */
export function isActiveFilter(rule: FilterRule, column: DatabaseColumn | undefined): boolean {
  if (!column || !FILTER_OPS_BY_TYPE[column.type].includes(rule.op)) return false;
  if (!opNeedsValue(rule.op)) return true;
  if (column.type === "checkbox") return typeof rule.value === "boolean";
  const v = rule.value;
  if (v === null || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (column.type === "number") return Number.isFinite(Number(v));
  if (column.type === "date") return toIsoDate(v) !== null;
  return true;
}

function operandLabels(value: FilterValue): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value) return [value];
  return [];
}

/** Whether `value` passes an active `rule` for `column`. */
export function matchesFilter(
  column: DatabaseColumn,
  rule: FilterRule,
  value: CellValue,
): boolean {
  const empty = isEmptyValue(value);
  switch (rule.op) {
    case "is-empty":
      return empty;
    case "is-not-empty":
      return !empty;
  }
  if (column.type === "checkbox") {
    return (value === true) === (rule.value === true);
  }
  switch (column.type) {
    case "title":
    case "text":
    case "link": {
      const text = cellText(value).toLowerCase();
      const needle = String(rule.value).trim().toLowerCase();
      if (rule.op === "contains") return text.includes(needle);
      if (rule.op === "not-contains") return !text.includes(needle);
      if (rule.op === "is") return text.trim() === needle;
      if (rule.op === "is-not") return text.trim() !== needle;
      return true;
    }
    case "number": {
      const target = Number(rule.value);
      if (empty || typeof value !== "number") return rule.op === "neq";
      if (rule.op === "eq") return value === target;
      if (rule.op === "neq") return value !== target;
      if (rule.op === "lt") return value < target;
      if (rule.op === "lte") return value <= target;
      if (rule.op === "gt") return value > target;
      if (rule.op === "gte") return value >= target;
      return true;
    }
    case "select":
    case "multi-select": {
      const labels = valueLabels(value);
      const wanted = operandLabels(rule.value);
      const any = labels.some((l) => wanted.includes(l));
      if (rule.op === "is") return labels.length === 1 && labels[0] === wanted[0];
      if (rule.op === "is-not") return !(labels.length === 1 && labels[0] === wanted[0]);
      if (rule.op === "is-any-of") return any;
      if (rule.op === "is-none-of") return !any;
      return true;
    }
    case "date": {
      const target = toIsoDate(rule.value);
      if (empty || typeof value !== "string" || !target) return false;
      if (rule.op === "on") return value === target;
      if (rule.op === "before") return value < target;
      if (rule.op === "after") return value > target;
      return true;
    }
  }
  return true;
}

/**
 * Sort order of two values. Empty values go last in both directions;
 * checkboxes sort unchecked before checked (ascending).
 */
export function compareForSort(
  column: DatabaseColumn,
  direction: SortDirection,
  a: CellValue,
  b: CellValue,
): number {
  const sign = direction === "desc" ? -1 : 1;
  if (column.type === "checkbox") {
    return sign * (Number(a === true) - Number(b === true));
  }
  const emptyA = isEmptyValue(a);
  const emptyB = isEmptyValue(b);
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  if (column.type === "number") return sign * ((a as number) - (b as number));
  if (column.type === "select" || column.type === "multi-select") {
    const order = new Map(column.options.map((o, i) => [o.label, i]));
    const rank = (v: CellValue) => order.get(valueLabels(v)[0]) ?? order.size;
    const diff = rank(a) - rank(b);
    if (diff) return sign * diff;
  }
  return (
    sign *
    cellText(a).localeCompare(cellText(b), undefined, {
      numeric: true,
      sensitivity: "base",
    })
  );
}

/**
 * The rows the view shows, in order: filtered (all active filters must
 * match), then sorted by each key in turn. Ties keep document order.
 */
export function applyView(
  columns: DatabaseColumn[],
  rows: DatabaseRow[],
  view: DatabaseViewState,
): DatabaseRow[] {
  const byId = new Map(columns.map((c) => [c.id, c]));
  const filters = view.filters
    .map((rule) => ({ rule, column: byId.get(rule.column) }))
    .filter(({ rule, column }) => isActiveFilter(rule, column)) as {
    rule: FilterRule;
    column: DatabaseColumn;
  }[];
  const sorts = view.sorts
    .map((rule) => ({ rule, column: byId.get(rule.column) }))
    .filter(({ column }) => column) as { rule: SortRule; column: DatabaseColumn }[];
  if (!filters.length && !sorts.length) return rows;

  const kept = filters.length
    ? rows.filter((row) =>
        filters.every(({ rule, column }) =>
          matchesFilter(column, rule, row.cells[column.id] ?? null),
        ),
      )
    : rows;
  if (!sorts.length) return kept;
  const indexed = kept.map((row, index) => ({ row, index }));
  indexed.sort((x, y) => {
    for (const { rule, column } of sorts) {
      const diff = compareForSort(
        column,
        rule.direction,
        x.row.cells[column.id] ?? null,
        y.row.cells[column.id] ?? null,
      );
      if (diff) return diff;
    }
    return x.index - y.index;
  });
  return indexed.map(({ row }) => row);
}
