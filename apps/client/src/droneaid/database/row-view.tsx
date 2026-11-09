import { MouseEvent, PointerEvent, memo } from "react";
import { Checkbox, Menu } from "@mantine/core";
import { IconGripVertical, IconRowInsertBottom, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { Node as PMNode } from "@tiptap/pm/model";
import { CellValue, DatabaseColumn, DatabaseRow } from "@docmost/editor-ext";
import { CellDisplay } from "./cell-display";
import { CellEditor, Move } from "./cell-editor";
import classes from "./database-view.module.css";

/** One table row: row handle and selection box, then one cell per column. */

export interface RowActions {
  cellMouseDown: (rowId: string, columnId: string, event: MouseEvent) => void;
  cellDoubleClick: (rowId: string, columnId: string) => void;
  toggle: (rowId: string, column: DatabaseColumn) => void;
  change: (rowId: string, column: DatabaseColumn, value: CellValue) => void;
  commit: (rowId: string, column: DatabaseColumn, value: CellValue, move: Move) => void;
  cancel: () => void;
  select: (rowId: string, selected: boolean, range: boolean) => void;
  handleDown: (rowId: string, event: PointerEvent) => void;
  menu: (rowId: string | null) => void;
  insertBelow: (rowId: string) => void;
  remove: (rowId: string) => void;
}

export interface Editing {
  initial?: string;
}

interface Props {
  row: DatabaseRow;
  rowNode: PMNode | undefined;
  columns: DatabaseColumn[];
  template: string;
  editable: boolean;
  top: number;
  activeColumn: string | null;
  editing: Editing | null;
  selected: boolean;
  menuOpen: boolean;
  actions: RowActions;
}

function RowViewInner({
  row,
  columns,
  template,
  editable,
  top,
  activeColumn,
  editing,
  selected,
  menuOpen,
  actions,
}: Props) {
  const { t } = useTranslation("droneaid");
  return (
    <div
      className={classes.row}
      style={{ gridTemplateColumns: template, transform: `translateY(${top}px)` }}
      data-row-id={row.id}
      data-selected={selected || undefined}
      role="row"
      aria-selected={selected}
    >
      <div className={classes.action}>
        {editable && (
          <>
            <Menu
              opened={menuOpen}
              onChange={(open) => actions.menu(open ? row.id : null)}
              position="bottom-start"
              withinPortal
              zIndex={250}
            >
              <Menu.Target>
                <button
                  type="button"
                  className={classes.grip}
                  title={t("database.rowHandle")}
                  aria-label={t("database.rowHandle")}
                  draggable={false}
                  // Keeps the browser from dragging the whole block natively,
                  // which would cancel the pointer events of the row drag.
                  onMouseDown={(e) => e.preventDefault()}
                  onPointerDown={(e) => actions.handleDown(row.id, e)}
                  onClick={(e) => e.preventDefault()}
                >
                  <IconGripVertical size={14} />
                </button>
              </Menu.Target>
              <Menu.Dropdown onMouseDown={(e) => e.stopPropagation()}>
                <Menu.Item
                  leftSection={<IconRowInsertBottom size={14} />}
                  onClick={() => actions.insertBelow(row.id)}
                >
                  {t("database.insertBelow")}
                </Menu.Item>
                <Menu.Item
                  color="red"
                  leftSection={<IconTrash size={14} />}
                  onClick={() => actions.remove(row.id)}
                >
                  {t("database.deleteRow")}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
            <Checkbox
              size="xs"
              className={classes.rowCheck}
              checked={selected}
              tabIndex={-1}
              aria-label={t("database.selectRow")}
              onChange={(e) => {
                const native = e.nativeEvent as unknown as globalThis.MouseEvent;
                actions.select(row.id, e.currentTarget.checked, Boolean(native?.shiftKey));
              }}
            />
          </>
        )}
      </div>
      {columns.map((column) => {
        const active = activeColumn === column.id;
        const value = row.cells[column.id] ?? null;
        return (
          <div
            key={column.id}
            className={classes.cell}
            role="gridcell"
            data-column-id={column.id}
            data-active={active || undefined}
            data-editing={(active && editing) || undefined}
            onMouseDown={(e) => actions.cellMouseDown(row.id, column.id, e)}
            onDoubleClick={() => actions.cellDoubleClick(row.id, column.id)}
          >
            {active && editing && editable && column.type !== "checkbox" ? (
              <CellEditor
                column={column}
                value={value}
                initial={editing.initial}
                onChange={(v) => actions.change(row.id, column, v)}
                onCommit={(v, move) => actions.commit(row.id, column, v, move)}
                onCancel={actions.cancel}
              />
            ) : (
              <CellDisplay
                column={column}
                value={value}
                editable={editable}
                onToggle={() => actions.toggle(row.id, column)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export const RowView = memo(
  RowViewInner,
  (prev, next) =>
    prev.rowNode === next.rowNode &&
    prev.row.id === next.row.id &&
    prev.columns === next.columns &&
    prev.top === next.top &&
    prev.editable === next.editable &&
    prev.template === next.template &&
    prev.activeColumn === next.activeColumn &&
    prev.editing === next.editing &&
    prev.selected === next.selected &&
    prev.menuOpen === next.menuOpen &&
    prev.actions === next.actions,
);
