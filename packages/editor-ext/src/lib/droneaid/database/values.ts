import {
  COLUMN_TYPES,
  CellInput,
  CellValue,
  ColumnType,
  DatabaseColumn,
  DatabaseError,
  OPTION_COLORS,
  SelectOption,
} from "./types";

/** Validation and conversion of cell values, per column type. */

const DAY_MS = 24 * 60 * 60 * 1000;
const TRUE_WORDS = new Set(["true", "yes", "y", "1", "x", "[x]", "✓", "✔", "checked", "oui"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "", "[ ]", "unchecked", "non"]);
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

export function isColumnType(type: unknown): type is ColumnType {
  return COLUMN_TYPES.includes(type as ColumnType);
}

export function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    value === false ||
    (Array.isArray(value) && value.length === 0)
  );
}

function fail(column: DatabaseColumn, message: string): never {
  throw new DatabaseError(`Column "${column.name}": ${message}`);
}

function asText(input: Exclude<CellInput, null | undefined>): string {
  if (Array.isArray(input)) return input.join(", ");
  return String(input);
}

function validDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** "YYYY-MM-DD" for a date input, or null if it is not one. */
export function toIsoDate(input: unknown): string | null {
  if (typeof input === "number" && Number.isFinite(input)) {
    // Milliseconds. AFFiNE stores local midnight; the nearest UTC midnight
    // is the calendar day it showed.
    return new Date(Math.round(input / DAY_MS) * DAY_MS)
      .toISOString()
      .slice(0, 10);
  }
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (!text) return null;
  const match = ISO_DATE.exec(text);
  if (match) {
    const [, y, m, d] = match.map(Number);
    return validDate(y, m, d) ? text.slice(0, 10) : null;
  }
  const time = Date.parse(text);
  if (!Number.isFinite(time)) return null;
  // A date without a zone is parsed as local time: keep its calendar day.
  const local = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`;
}

function toLink(text: string): string | null {
  const value = text.trim();
  if (!value) return null;
  if (/\s/.test(value)) return null;
  if (/^(https?:|mailto:|tel:)/i.test(value)) return value;
  if (/^[^\s/]+\.[^\s/]+/.test(value)) return `https://${value}`;
  return null;
}

/** "1 234,5" and "1,234.5" -> "1234.5"; a single comma is a decimal comma. */
function normaliseNumber(input: string): string {
  const text = input.trim().replace(/[\s  ]/g, "");
  if (text.includes(".") && text.includes(",")) return text.replace(/,/g, "");
  if ((text.match(/,/g) ?? []).length === 1) return text.replace(",", ".");
  return text;
}

function splitLabels(input: Exclude<CellInput, null | undefined>): string[] {
  const list = Array.isArray(input) ? input : String(input).split(",");
  const labels = list.map((label) => String(label).trim()).filter(Boolean);
  return [...new Set(labels)];
}

/**
 * The value to store for `input` in `column`, or null for an empty cell.
 *
 * Strict by default: a value that does not fit the type throws a
 * DatabaseError. With `lenient`, it becomes empty instead (used when a whole
 * column is retyped). Select labels that are not yet options are accepted;
 * `optionsWith` adds them to the column.
 */
export function toCellValue(
  column: DatabaseColumn,
  input: CellInput,
  lenient = false,
): CellValue {
  if (input === null || input === undefined) return null;
  switch (column.type) {
    case "title":
    case "text": {
      const text = asText(input);
      return text === "" ? null : text;
    }
    case "number": {
      if (typeof input === "number") {
        if (Number.isFinite(input)) return input;
        return lenient ? null : fail(column, "not a finite number");
      }
      if (typeof input === "boolean") {
        return lenient ? (input ? 1 : null) : fail(column, "expected a number");
      }
      const text = normaliseNumber(asText(input));
      if (!text) return null;
      const strict = Number(text);
      if (Number.isFinite(strict)) return strict;
      if (lenient) {
        const loose = parseFloat(text);
        return Number.isFinite(loose) ? loose : null;
      }
      return fail(column, `"${asText(input)}" is not a number`);
    }
    case "checkbox": {
      if (typeof input === "boolean") return input || null;
      if (typeof input === "number") return input !== 0 || null;
      const text = asText(input).trim().toLowerCase();
      if (TRUE_WORDS.has(text)) return true;
      if (FALSE_WORDS.has(text) || lenient) return null;
      return fail(column, `"${asText(input)}" is not yes or no`);
    }
    case "date": {
      if (typeof input === "boolean") {
        return lenient ? null : fail(column, "expected a date");
      }
      if (typeof input === "string" && !input.trim()) return null;
      const date = toIsoDate(Array.isArray(input) ? input[0] : input);
      if (date) return date;
      return lenient
        ? null
        : fail(column, `"${asText(input)}" is not a date (use YYYY-MM-DD)`);
    }
    case "link": {
      const text = asText(input);
      if (!text.trim()) return null;
      const link = toLink(text);
      if (link) return link;
      return lenient ? null : fail(column, `"${text}" is not a link`);
    }
    case "select": {
      const label = splitLabels(
        Array.isArray(input) ? input.slice(0, 1) : [asText(input)],
      )[0];
      return label ?? null;
    }
    case "multi-select": {
      const labels = splitLabels(input);
      return labels.length ? labels : null;
    }
    default:
      return fail(column, `unknown column type "${column.type}"`);
  }
}

/** A stored value read back defensively (stored data may be anything). */
export function readCellValue(column: DatabaseColumn, raw: unknown): CellValue {
  if (raw === null || raw === undefined) return null;
  try {
    return toCellValue(column, raw as CellInput, true);
  } catch {
    return null;
  }
}

/** Plain text for a value, as shown in Markdown, search and text columns. */
export function cellText(value: CellValue): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/** A value converted to another column type (for retyping a column). */
export function convertValue(
  from: DatabaseColumn,
  to: DatabaseColumn,
  value: CellValue,
): CellValue {
  if (value === null) return null;
  if (from.type === to.type) return value;
  if (Array.isArray(value)) return toCellValue(to, value, true);
  if (to.type === "multi-select" && typeof value === "string") {
    return toCellValue(to, value, true);
  }
  if (from.type === "checkbox") {
    return to.type === "number" ? 1 : toCellValue(to, cellText(value), true);
  }
  return toCellValue(to, typeof value === "number" ? value : cellText(value), true);
}

/** Labels used by a value (select and multi-select), else []. */
export function valueLabels(value: CellValue): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value;
  return [];
}

/**
 * The column's options plus any of `labels` it does not have yet, each new
 * one with the next palette colour. Returns the same array when nothing is new.
 */
export function optionsWith(
  options: SelectOption[],
  labels: string[],
): SelectOption[] {
  const known = new Set(options.map((o) => o.label));
  const added: SelectOption[] = [];
  for (const label of labels) {
    if (known.has(label)) continue;
    known.add(label);
    added.push({
      label,
      color: OPTION_COLORS[(options.length + added.length) % OPTION_COLORS.length],
    });
  }
  return added.length ? [...options, ...added] : options;
}

/** Options as stored, cleaned (stored data may be anything). */
export function readOptions(raw: unknown): SelectOption[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const options: SelectOption[] = [];
  for (const item of raw) {
    const label =
      typeof item === "string"
        ? item
        : item && typeof item === "object" && typeof item.label === "string"
          ? item.label
          : null;
    if (!label || seen.has(label)) continue;
    seen.add(label);
    const color = OPTION_COLORS.includes(item?.color)
      ? (item.color as SelectOption["color"])
      : OPTION_COLORS[options.length % OPTION_COLORS.length];
    options.push({ label, color });
  }
  return options;
}

/** Compares values for sorting: empty last, then by type. */
export function compareValues(
  column: DatabaseColumn,
  a: CellValue,
  b: CellValue,
): number {
  const emptyA = isEmptyValue(a);
  const emptyB = isEmptyValue(b);
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  if (column.type === "number") return (a as number) - (b as number);
  if (column.type === "checkbox") return 0;
  if (column.type === "select" || column.type === "multi-select") {
    const order = new Map(column.options.map((o, i) => [o.label, i]));
    const rank = (v: CellValue) => order.get(valueLabels(v)[0]) ?? order.size;
    const diff = rank(a) - rank(b);
    if (diff) return diff;
  }
  return cellText(a).localeCompare(cellText(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}
