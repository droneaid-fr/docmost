import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CellValue,
  DatabaseColumn,
  DatabaseError,
  cellText,
  toCellValue,
} from "@docmost/editor-ext";
import { SelectEditor } from "./select-editor";
import classes from "./database-view.module.css";

/**
 * The editor for the active cell, mounted only while editing. Enter
 * commits, Tab / Shift+Tab commit and move, Escape cancels, blur commits.
 * Invalid input stays open and is flagged.
 */

export type Move = "up" | "down" | "left" | "right" | null;

export interface CellEditorProps {
  column: DatabaseColumn;
  value: CellValue;
  /** Text typed to start editing; replaces the value. */
  initial?: string;
  /** Saves a value without leaving edit mode (multi-select toggles). */
  onChange: (value: CellValue) => void;
  /** Saves (unless unchanged) and leaves edit mode, then moves. */
  onCommit: (value: CellValue, move: Move) => void;
  onCancel: () => void;
}

function moveFor(event: KeyboardEvent): Move | undefined {
  if (event.key === "Tab") return event.shiftKey ? "left" : "right";
  if (event.key === "Enter") return null;
  return undefined;
}

function InputEditor({ column, value, initial, onCommit, onCancel }: CellEditorProps) {
  const { t } = useTranslation("droneaid");
  const isDate = column.type === "date";
  const [draft, setDraft] = useState(
    initial !== undefined && !isDate ? initial : isDate ? String(value ?? "") : cellText(value),
  );
  const [invalid, setInvalid] = useState(false);
  const done = useRef(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    if (initial === undefined && !isDate) input.select();
  }, []);

  const commit = (move: Move) => {
    if (done.current) return;
    try {
      const next = toCellValue(column, draft);
      done.current = true;
      onCommit(next, move);
    } catch (error) {
      if (!(error instanceof DatabaseError)) throw error;
      setInvalid(true);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      done.current = true;
      onCancel();
      return;
    }
    const move = moveFor(event);
    if (move !== undefined) {
      event.preventDefault();
      commit(move);
    }
  };

  return (
    <input
      ref={ref}
      type={isDate ? "date" : "text"}
      className={classes.input}
      data-invalid={invalid || undefined}
      title={invalid ? t("database.invalid") : undefined}
      aria-invalid={invalid || undefined}
      value={draft}
      inputMode={column.type === "number" ? "decimal" : undefined}
      style={column.type === "number" ? { textAlign: "right" } : undefined}
      onChange={(e) => {
        setDraft(e.currentTarget.value);
        setInvalid(false);
      }}
      onBlur={() => {
        if (done.current) return;
        try {
          const next = toCellValue(column, draft);
          done.current = true;
          onCommit(next, null);
        } catch {
          // Leaving an invalid value: keep the old one.
          done.current = true;
          onCancel();
        }
      }}
      onKeyDown={onKeyDown}
      aria-label={column.name}
    />
  );
}

export function CellEditor(props: CellEditorProps) {
  if (props.column.type === "select" || props.column.type === "multi-select") {
    return <SelectEditor {...props} />;
  }
  return <InputEditor {...props} />;
}
