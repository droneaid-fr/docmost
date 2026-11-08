import { memo, useEffect, useState, KeyboardEvent } from "react";
import { Checkbox, TagsInput } from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import {
  CellValue,
  DatabaseColumn,
  DatabaseError,
  cellText,
  toCellValue,
} from "@docmost/editor-ext";
import classes from "./database-view.module.css";

/**
 * One cell, edited in place. Text-like cells commit on blur or Enter (Escape
 * reverts); the others commit on change. Invalid input reverts and flags.
 */

export interface CellEditorProps {
  column: DatabaseColumn;
  value: CellValue;
  editable: boolean;
  onChange: (value: CellValue) => void;
}

function TextLikeCell({ column, value, editable, onChange }: CellEditorProps) {
  const text = cellText(value);
  const [draft, setDraft] = useState(text);
  const [focused, setFocused] = useState(false);
  const [invalid, setInvalid] = useState(false);

  // Remote edits replace the draft unless this user is typing in the cell.
  useEffect(() => {
    if (!focused) setDraft(text);
  }, [text, focused]);

  const commit = () => {
    if (draft === text) return;
    try {
      onChange(toCellValue(column, draft));
      setInvalid(false);
    } catch (error) {
      if (!(error instanceof DatabaseError)) throw error;
      setInvalid(true);
      setDraft(text);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") event.currentTarget.blur();
    if (event.key === "Escape") {
      setDraft(text);
      event.currentTarget.blur();
    }
  };

  return (
    <div className={classes.textCell}>
      <input
        className={classes.input}
        data-invalid={invalid || undefined}
        value={draft}
        readOnly={!editable}
        inputMode={column.type === "number" ? "decimal" : undefined}
        style={column.type === "number" ? { textAlign: "right" } : undefined}
        onFocus={() => setFocused(true)}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onKeyDown={onKeyDown}
        aria-label={column.name}
      />
      {column.type === "link" && typeof value === "string" && (
        <a
          className={classes.linkOpen}
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open link"
        >
          <IconExternalLink size={14} />
        </a>
      )}
    </div>
  );
}

function SelectCell({ column, value, editable, onChange }: CellEditorProps) {
  const labels = Array.isArray(value) ? value : value ? [String(value)] : [];
  const single = column.type === "select";
  return (
    <TagsInput
      size="xs"
      variant="unstyled"
      className={classes.tags}
      data={column.options.map((o) => o.label)}
      value={labels}
      maxTags={single ? 1 : undefined}
      readOnly={!editable}
      clearable={false}
      comboboxProps={{ withinPortal: true }}
      onChange={(next) => {
        const list = single ? next.slice(-1) : next;
        onChange(toCellValue(column, list));
      }}
      aria-label={column.name}
    />
  );
}

function CellEditorInner(props: CellEditorProps) {
  const { column, value, editable, onChange } = props;
  switch (column.type) {
    case "checkbox":
      return (
        <div className={classes.center}>
          <Checkbox
            size="xs"
            checked={value === true}
            disabled={!editable}
            onChange={(e) => onChange(e.currentTarget.checked || null)}
            aria-label={column.name}
          />
        </div>
      );
    case "date":
      return (
        <input
          type="date"
          className={classes.input}
          value={typeof value === "string" ? value : ""}
          readOnly={!editable}
          onChange={(e) => onChange(toCellValue(column, e.currentTarget.value, true))}
          aria-label={column.name}
        />
      );
    case "select":
    case "multi-select":
      return <SelectCell {...props} />;
    default:
      return <TextLikeCell {...props} />;
  }
}

export const CellEditor = memo(CellEditorInner);
