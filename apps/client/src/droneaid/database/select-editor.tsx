import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { CloseButton, Popover, ScrollArea, UnstyledButton } from "@mantine/core";
import { IconCheck, IconPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { CellValue, toCellValue, valueLabels } from "@docmost/editor-ext";
import type { CellEditorProps } from "./cell-editor";
import { OptionPill } from "./cell-display";
import { optionColorVars } from "./labels";
import classes from "./database-view.module.css";

/**
 * Dropdown editor for select and multi-select cells: type to filter, arrows
 * to move, Enter to pick (or create the typed label), Backspace on an empty
 * search removes the last label, Escape closes. A single select commits and
 * closes on pick; a multi-select saves each toggle and stays open.
 */

interface Item {
  label: string;
  create: boolean;
}

export function SelectEditor({ column, value, initial, onChange, onCommit, onCancel }: CellEditorProps) {
  const { t } = useTranslation("droneaid");
  const single = column.type === "select";
  const [labels, setLabels] = useState<string[]>(valueLabels(value));
  const [search, setSearch] = useState(initial ?? "");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const closed = useRef(false);

  // A remote edit of this cell while the dropdown is open shows up here.
  const remote = JSON.stringify(valueLabels(value));
  useEffect(() => setLabels(valueLabels(value)), [remote]);

  const items = useMemo<Item[]>(() => {
    const needle = search.trim().toLowerCase();
    const list: Item[] = column.options
      .filter((o) => !needle || o.label.toLowerCase().includes(needle))
      .map((o) => ({ label: o.label, create: false }));
    const exact = column.options.some((o) => o.label.toLowerCase() === needle);
    if (needle && !exact) list.push({ label: search.trim(), create: true });
    return list;
  }, [column.options, search]);

  useEffect(() => setHighlight(0), [search]);

  const close = (next: CellValue) => {
    if (closed.current) return;
    closed.current = true;
    onCommit(next, null);
  };

  const pick = (label: string) => {
    if (single) {
      close(toCellValue(column, [label]));
      return;
    }
    const next = labels.includes(label)
      ? labels.filter((l) => l !== label)
      : [...labels, label];
    setLabels(next);
    setSearch("");
    onChange(toCellValue(column, next));
  };

  const remove = (label: string) => {
    const next = labels.filter((l) => l !== label);
    setLabels(next);
    onChange(toCellValue(column, next));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((h) => Math.min(items.length - 1, h + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = items[highlight];
      if (item) pick(item.label);
      else if (!search.trim()) close(toCellValue(column, labels));
    } else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      if (closed.current) return;
      closed.current = true;
      if (single) onCancel();
      else onCommit(toCellValue(column, labels), event.key === "Tab" ? (event.shiftKey ? "left" : "right") : null);
    } else if (event.key === "Backspace" && !search && labels.length) {
      event.preventDefault();
      remove(labels[labels.length - 1]);
    }
  };

  return (
    <Popover
      opened
      position="bottom-start"
      width={260}
      shadow="md"
      trapFocus={false}
      returnFocus={false}
      onDismiss={() => close(toCellValue(column, labels))}
      zIndex={300}
    >
      <Popover.Target>
        <div className={classes.pills} data-editing>
          {labels.map((label) => (
            <OptionPill key={label} column={column} label={label} />
          ))}
        </div>
      </Popover.Target>
      <Popover.Dropdown p={6} onMouseDown={(e) => e.stopPropagation()}>
        {!single && labels.length > 0 && (
          <div className={classes.pickedPills}>
            {labels.map((label) => (
              <span key={label} className={classes.pickedPill}>
                <OptionPill column={column} label={label} />
                <CloseButton
                  size="xs"
                  aria-label={t("database.select.remove", { label })}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => remove(label)}
                />
              </span>
            ))}
          </div>
        )}
        <input
          ref={inputRef}
          autoFocus
          className={classes.selectSearch}
          placeholder={t("database.select.search")}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          aria-label={column.name}
          role="combobox"
          aria-expanded
        />
        <ScrollArea.Autosize mah={240} type="auto">
          <div role="listbox">
            {items.length === 0 && (
              <div className={classes.selectEmpty}>{t("database.select.none")}</div>
            )}
            {items.map((item, index) => {
              const option = column.options.find((o) => o.label === item.label);
              return (
                <UnstyledButton
                  key={`${item.create}:${item.label}`}
                  className={classes.selectItem}
                  data-highlighted={index === highlight || undefined}
                  role="option"
                  aria-selected={labels.includes(item.label)}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => pick(item.label)}
                >
                  {item.create ? (
                    <>
                      <IconPlus size={14} />
                      <span>{t("database.select.create", { label: item.label })}</span>
                    </>
                  ) : (
                    <>
                      <span className={classes.pill} style={optionColorVars(option?.color)}>
                        {item.label}
                      </span>
                      {labels.includes(item.label) && <IconCheck size={14} />}
                    </>
                  )}
                </UnstyledButton>
              );
            })}
          </div>
        </ScrollArea.Autosize>
      </Popover.Dropdown>
    </Popover>
  );
}
