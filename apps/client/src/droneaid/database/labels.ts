import type { TFunction } from "i18next";
import {
  IconAlignLeft,
  IconCalendar,
  IconCircleChevronDown,
  IconHash,
  IconLetterT,
  IconLink,
  IconList,
  IconSquareCheck,
} from "@tabler/icons-react";
import {
  COLUMN_TYPES,
  ColumnType,
  DatabaseColumn,
  FilterOp,
  FilterRule,
  OptionColor,
  cellText,
  opNeedsValue,
} from "@docmost/editor-ext";

/** Display helpers for the database UI (i18n namespace "droneaid"). */

export const TYPE_ICONS: Record<ColumnType, typeof IconHash> = {
  title: IconLetterT,
  text: IconAlignLeft,
  number: IconHash,
  select: IconCircleChevronDown,
  "multi-select": IconList,
  date: IconCalendar,
  checkbox: IconSquareCheck,
  link: IconLink,
};

export function typeLabel(t: TFunction, type: ColumnType): string {
  return t(`database.type.${type}`);
}

/** Types a column can be changed to (never title). */
export function retypeOptions(t: TFunction) {
  return COLUMN_TYPES.filter((type) => type !== "title").map((type) => ({
    value: type,
    label: typeLabel(t, type),
  }));
}

export function opLabel(t: TFunction, op: FilterOp, type?: ColumnType): string {
  if (type === "checkbox" && op === "is") return t("database.op.checkbox-is");
  return t(`database.op.${op}`);
}

/** Chip text for a filter, e.g. "Status is any of Done, Open". */
export function filterSummary(
  t: TFunction,
  rule: FilterRule,
  column: DatabaseColumn | undefined,
): string {
  const name = column?.name ?? t("database.deletedColumn");
  const op = opLabel(t, rule.op, column?.type);
  if (!opNeedsValue(rule.op)) return `${name} ${op}`;
  let value: string;
  if (column?.type === "checkbox") {
    value = rule.value === true ? t("database.checked") : t("database.unchecked");
  } else {
    value = cellText(rule.value as any) || "…";
  }
  return `${name} ${op} ${value}`;
}

export function optionColorVars(color: OptionColor | undefined) {
  const c = color ?? "gray";
  return {
    background: `var(--mantine-color-${c}-light)`,
    color: `var(--mantine-color-${c}-light-color)`,
  };
}
