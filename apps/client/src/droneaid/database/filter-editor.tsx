import { useEffect, useState } from "react";
import { ActionIcon, Group, MultiSelect, Select, SegmentedControl, TextInput } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  DatabaseColumn,
  FILTER_OPS_BY_TYPE,
  FilterOp,
  FilterRule,
  FilterValue,
  opNeedsValue,
} from "@docmost/editor-ext";
import { opLabel } from "./labels";

/** One filter rule: column, operator and an operand input fitting the type. */

const COMBO = { withinPortal: false } as const;

/** A text operand, saved on Enter or blur (not on every keystroke). */
function DraftInput({
  value,
  type,
  onCommit,
  label,
}: {
  value: FilterValue;
  type: "text" | "number" | "date";
  onCommit: (value: string) => void;
  label: string;
}) {
  const initial = value === null || Array.isArray(value) ? "" : String(value);
  const [draft, setDraft] = useState(initial);
  useEffect(() => setDraft(initial), [initial]);
  const commit = () => draft !== initial && onCommit(draft);
  return (
    <TextInput
      size="xs"
      style={{ flex: 1 }}
      type={type}
      value={draft}
      aria-label={label}
      placeholder={label}
      onChange={(e) => {
        setDraft(e.currentTarget.value);
        if (type === "date") onCommit(e.currentTarget.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

function OperandInput({
  rule,
  column,
  onChange,
}: {
  rule: FilterRule;
  column: DatabaseColumn;
  onChange: (value: FilterValue) => void;
}) {
  const { t } = useTranslation("droneaid");
  const label = t("database.value");
  if (!opNeedsValue(rule.op)) return <div style={{ flex: 1 }} />;
  switch (column.type) {
    case "checkbox":
      return (
        <SegmentedControl
          size="xs"
          style={{ flex: 1 }}
          value={rule.value === true ? "1" : "0"}
          data={[
            { value: "1", label: t("database.checked") },
            { value: "0", label: t("database.unchecked") },
          ]}
          onChange={(v) => onChange(v === "1")}
        />
      );
    case "select":
    case "multi-select": {
      const data = column.options.map((o) => o.label);
      if (rule.op === "is" || rule.op === "is-not") {
        const current = Array.isArray(rule.value) ? rule.value[0] : rule.value;
        return (
          <Select
            size="xs"
            style={{ flex: 1 }}
            data={data}
            searchable
            value={typeof current === "string" ? current : null}
            comboboxProps={COMBO}
            onChange={(v) => onChange(v)}
            aria-label={label}
            placeholder={label}
          />
        );
      }
      const list = Array.isArray(rule.value)
        ? rule.value
        : typeof rule.value === "string"
          ? [rule.value]
          : [];
      return (
        <MultiSelect
          size="xs"
          style={{ flex: 1 }}
          data={data}
          searchable
          value={list}
          comboboxProps={COMBO}
          onChange={(v) => onChange(v)}
          aria-label={label}
          placeholder={list.length ? undefined : label}
        />
      );
    }
    case "number":
      return <DraftInput value={rule.value} type="number" label={label} onCommit={(v) => onChange(v === "" ? null : Number(v))} />;
    case "date":
      return <DraftInput value={rule.value} type="date" label={label} onCommit={(v) => onChange(v || null)} />;
    default:
      return <DraftInput value={rule.value} type="text" label={label} onCommit={(v) => onChange(v)} />;
  }
}

export function FilterRuleEditor({
  rule,
  columns,
  onChange,
  onRemove,
}: {
  rule: FilterRule;
  columns: DatabaseColumn[];
  onChange: (rule: FilterRule) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("droneaid");
  const column = columns.find((c) => c.id === rule.column);
  const ops = column ? FILTER_OPS_BY_TYPE[column.type] : [];
  return (
    <Group gap={6} wrap="nowrap" data-filter-id={rule.id}>
      <Select
        size="xs"
        w={130}
        data={columns.map((c) => ({ value: c.id, label: c.name }))}
        value={column ? rule.column : null}
        placeholder={t("database.deletedColumn")}
        allowDeselect={false}
        comboboxProps={COMBO}
        aria-label={t("database.filter")}
        onChange={(id) => {
          const next = columns.find((c) => c.id === id);
          if (!next) return;
          const sameType = column && column.type === next.type;
          onChange({
            ...rule,
            column: next.id,
            op: sameType ? rule.op : FILTER_OPS_BY_TYPE[next.type][0],
            value: sameType ? rule.value : next.type === "checkbox" ? true : null,
          });
        }}
      />
      <Select
        size="xs"
        w={130}
        data={ops.map((op) => ({ value: op, label: opLabel(t, op, column?.type) }))}
        value={column && ops.includes(rule.op) ? rule.op : null}
        allowDeselect={false}
        comboboxProps={COMBO}
        disabled={!column}
        onChange={(op) => {
          if (!op) return;
          const multi = op === "is-any-of" || op === "is-none-of";
          let value = rule.value;
          if (multi && typeof value === "string") value = [value];
          if (!multi && Array.isArray(value)) value = value[0] ?? null;
          onChange({ ...rule, op: op as FilterOp, value });
        }}
      />
      {column ? (
        <OperandInput rule={rule} column={column} onChange={(value) => onChange({ ...rule, value })} />
      ) : (
        <div style={{ flex: 1 }} />
      )}
      <ActionIcon variant="subtle" color="gray" aria-label={t("database.removeRule")} onClick={onRemove}>
        <IconX size={14} />
      </ActionIcon>
    </Group>
  );
}
