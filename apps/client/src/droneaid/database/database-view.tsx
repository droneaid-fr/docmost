import {
  ClipboardEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { NodeViewProps, NodeViewWrapper, useEditorState } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ActionIcon, Button, Checkbox, Group, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconPlus, IconTrash, IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  CellValue,
  ColumnType,
  DATABASE_ROW_NODE,
  DatabaseColumn,
  DatabaseError,
  cellText,
  readDatabaseNode,
  titleColumn,
  toCellValue,
  uniqueColumnName,
} from "@docmost/editor-ext";
import {
  addRow,
  moveRow,
  removeRow,
  removeRows,
  setCellValue,
  setDatabaseTitle,
  setDatabaseView,
} from "./commands";
import {
  addColumn,
  changeOptions,
  countOptionUse,
  moveColumn,
  previewRetype,
  removeColumn,
  renameColumn,
  retypeColumn,
  setColumnWidth,
} from "./column-commands";
import { ColumnActions, ColumnHeader } from "./column-header";
import type { Move } from "./cell-editor";
import { OptionsEditor } from "./options-editor";
import { Editing, RowActions, RowView } from "./row-view";
import { displayRows, useViewState } from "./use-view-state";
import { ViewButtons, ViewChips, newFilter, usePanel, withSort } from "./view-toolbar";
import { typeLabel } from "./labels";
import classes from "./database-view.module.css";

/**
 * Table view of a database block. The node has no contentDOM: this view
 * draws everything from the node. Rows are virtualised and memoised on the
 * identity of their ProseMirror node, so an edit re-renders one row.
 *
 * Keyboard (when the table has focus): arrows and Tab move the active cell,
 * Enter or typing edits it, Escape leaves the table, Delete clears, Ctrl+C
 * and Ctrl+V copy and paste a cell value, Ctrl+Z undoes.
 */

const ROW_HEIGHT = 34;
const HEADER_HEIGHT = 34;
const MAX_BODY_HEIGHT = 520;
const ACTION_WIDTH = 52;
const ADD_COLUMN_WIDTH = 40;
const DEFAULT_WIDTH: Record<DatabaseColumn["type"], number> = {
  title: 220,
  text: 220,
  number: 100,
  select: 150,
  "multi-select": 200,
  date: 140,
  checkbox: 80,
  link: 200,
};

interface Active {
  rowId: string;
  columnId: string;
}

interface Drag {
  rowId: string;
  index: number;
  place: "before" | "after";
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

function sameValue(a: CellValue, b: CellValue) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export default function DatabaseView(props: NodeViewProps) {
  const { node, editor, getPos } = props;
  const { t } = useTranslation("droneaid");
  const editable = useEditorState({
    editor,
    selector: (ctx) => ctx.editor?.isEditable ?? false,
  });

  const data = useMemo(() => readDatabaseNode(node), [node]);
  const rowNodes = useMemo(() => {
    const map = new Map<string, PMNode>();
    node.forEach((child) => {
      if (child.type.name === DATABASE_ROW_NODE) map.set(child.attrs.id, child);
    });
    return map;
  }, [node]);

  // Stable while the schema is unchanged, so rows stay memoised.
  const columnsKey = JSON.stringify(data.columns);
  const columns = useMemo(() => data.columns, [columnsKey]);

  const [liveWidth, setLiveWidth] = useState<{ id: string; width: number } | null>(null);
  const widthOf = (c: DatabaseColumn) =>
    liveWidth?.id === c.id ? liveWidth.width : (c.width ?? DEFAULT_WIDTH[c.type]);
  const template = useMemo(
    () =>
      [ACTION_WIDTH, ...columns.map(widthOf), ...(editable ? [ADD_COLUMN_WIDTH] : [])]
        .map((w) => `${Math.round(w)}px`)
        .join(" "),
    [columns, liveWidth, editable],
  );

  // Latest values for stable handlers.
  const latest = useRef({ editor, getPos });
  latest.current = { editor, getPos };

  const persistView = useCallback((view: any) => {
    const { editor, getPos } = latest.current;
    setDatabaseView(editor, getPos, view);
  }, []);
  const { view, setView, isLocal, resetLocal, pins, pin } = useViewState(
    node.attrs.view,
    editable,
    persistView,
  );
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const setViewRef = useRef(setView);
  setViewRef.current = setView;
  const rows = useMemo(
    () => displayRows(columns, data.rows, view, pins),
    [columns, data.rows, view, pins],
  );
  const rowIndex = useMemo(() => new Map(rows.map((r, i) => [r.id, i])), [rows]);
  const filtered = rows.length !== data.rows.length;
  const pinnedShown = pins.filter((p) => rowIndex.has(p.rowId)).length;

  const [active, setActive] = useState<Active | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [menuRow, setMenuRow] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [panel, setPanel] = usePanel();
  const [optionsFor, setOptionsFor] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const selectAnchor = useRef<string | null>(null);
  const justDragged = useRef(false);
  const pendingScroll = useRef<Active | null>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    getItemKey: (index) => rows[index]?.id ?? index,
  });

  const state = useRef({ rows, rowIndex, columns, active, editing, view, editable, selected, data });
  state.current = { rows, rowIndex, columns, active, editing, view, editable, selected, data };

  // Forget the active cell and selections whose row or column is gone.
  useEffect(() => {
    if (active && (!rowNodes.has(active.rowId) || !columns.some((c) => c.id === active.columnId))) {
      setActive(null);
      setEditing(null);
    }
    if ([...selected].some((id) => !rowNodes.has(id))) {
      setSelected(new Set([...selected].filter((id) => rowNodes.has(id))));
    }
  }, [rowNodes, columns]);

  const focusGrid = () => scrollRef.current?.focus({ preventScroll: true });

  const scrollToCell = (target: Active) => {
    const el = scrollRef.current;
    const index = state.current.rowIndex.get(target.rowId);
    if (!el || index === undefined) return;
    const top = index * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (HEADER_HEIGHT + top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = HEADER_HEIGHT + top + ROW_HEIGHT - el.clientHeight;
    }
    requestAnimationFrame(() => {
      const cell = el.querySelector(
        `[data-row-id="${CSS.escape(target.rowId)}"] [data-column-id="${CSS.escape(target.columnId)}"]`,
      ) as HTMLElement | null;
      if (!cell) return;
      const left = cell.offsetLeft;
      const right = left + cell.offsetWidth;
      if (left < el.scrollLeft + ACTION_WIDTH) el.scrollLeft = Math.max(0, left - ACTION_WIDTH);
      else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
    });
  };

  // Scroll to a row added by this user once it is rendered.
  useEffect(() => {
    const target = pendingScroll.current;
    if (target && rowIndex.has(target.rowId)) {
      pendingScroll.current = null;
      scrollToCell(target);
    }
  }, [rowIndex]);

  const activate = (rowId: string, columnId: string, edit: Editing | null = null) => {
    const next = { rowId, columnId };
    setActive(next);
    setEditing(edit);
    scrollToCell(next);
  };

  const moveActive = (move: Move) => {
    const { active, rows, rowIndex, columns } = state.current;
    if (!move || !rows.length || !columns.length) return;
    if (!active) return activate(rows[0].id, columns[0].id);
    let r = rowIndex.get(active.rowId) ?? 0;
    let c = columns.findIndex((col) => col.id === active.columnId);
    if (move === "up") r--;
    else if (move === "down") r++;
    else if (move === "left") {
      c--;
      if (c < 0 && r > 0) [r, c] = [r - 1, columns.length - 1];
    } else if (move === "right") {
      c++;
      if (c >= columns.length && r < rows.length - 1) [r, c] = [r + 1, 0];
    }
    r = clamp(r, 0, rows.length - 1);
    c = clamp(c, 0, columns.length - 1);
    activate(rows[r].id, columns[c].id);
  };

  const writeCell = (rowId: string, column: DatabaseColumn, value: CellValue) => {
    const { editor, getPos } = latest.current;
    setCellValue(editor, getPos, rowId, column, value);
  };

  const valueAt = (target: Active): { column?: DatabaseColumn; value: CellValue } => {
    const { columns, data } = state.current;
    const column = columns.find((c) => c.id === target.columnId);
    const row = data.rows.find((r) => r.id === target.rowId);
    return { column, value: (column && row?.cells[column.id]) ?? null };
  };

  const startEdit = (target: Active, initial?: string) => {
    const { column, value } = valueAt(target);
    if (!column || !state.current.editable) return;
    if (column.type === "checkbox") {
      if (initial === undefined) writeCell(target.rowId, column, value === true ? null : true);
      return;
    }
    activate(target.rowId, target.columnId, { initial });
  };

  const newRow = (after: string | null) => {
    const { editor, getPos } = latest.current;
    const id = addRow(editor, getPos, after ?? undefined);
    if (!id) return;
    pinRef.current(id, after);
    const title = titleColumn(state.current.columns);
    if (title) {
      const target = { rowId: id, columnId: title.id };
      setActive(target);
      setEditing(null);
      pendingScroll.current = target;
      focusGrid();
    }
  };

  const confirmRemoveRows = (ids: string[]) => {
    modals.openConfirmModal({
      title: t("database.confirmDeleteRows.title"),
      children: <Text size="sm">{t("database.confirmDeleteRows.body", { count: ids.length })}</Text>,
      labels: { confirm: t("database.delete"), cancel: t("database.cancel") },
      confirmProps: { color: "red" },
      onConfirm: () => {
        const { editor, getPos } = latest.current;
        removeRows(editor, getPos, ids);
        setSelected(new Set());
      },
    });
  };

  const rowActions = useMemo<RowActions>(
    () => ({
      cellMouseDown: (rowId, columnId, event: MouseEvent) => {
        const target = event.target as HTMLElement;
        if (target.closest("input, textarea, a")) return;
        event.preventDefault();
        const { active, editing } = state.current;
        const same = active?.rowId === rowId && active.columnId === columnId;
        focusGrid();
        if (same && !editing) {
          const { column } = valueAt({ rowId, columnId });
          if (column?.type !== "checkbox") startEdit({ rowId, columnId });
          return;
        }
        if (!same) activate(rowId, columnId);
      },
      cellDoubleClick: (rowId, columnId) => startEdit({ rowId, columnId }),
      toggle: (rowId, column) => {
        if (!state.current.editable) return;
        const { value } = valueAt({ rowId, columnId: column.id });
        writeCell(rowId, column, value === true ? null : true);
        setActive({ rowId, columnId: column.id });
        focusGrid();
      },
      change: (rowId, column, value) => writeCell(rowId, column, value),
      commit: (rowId, column, value, move) => {
        const { value: before } = valueAt({ rowId, columnId: column.id });
        if (!sameValue(before, value)) writeCell(rowId, column, value);
        setEditing(null);
        focusGrid();
        if (move) moveActive(move);
      },
      cancel: () => {
        setEditing(null);
        focusGrid();
      },
      select: (rowId, checked, range) => {
        const { rows, selected } = state.current;
        const next = new Set(selected);
        const anchor = selectAnchor.current;
        if (range && anchor) {
          const a = rows.findIndex((r) => r.id === anchor);
          const b = rows.findIndex((r) => r.id === rowId);
          if (a >= 0 && b >= 0) {
            for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
              if (checked) next.add(rows[i].id);
              else next.delete(rows[i].id);
            }
          }
        } else if (checked) next.add(rowId);
        else next.delete(rowId);
        selectAnchor.current = rowId;
        setSelected(next);
      },
      handleDown: (rowId, event: PointerEvent) => {
        if (event.button !== 0) return;
        const startY = event.clientY;
        let moved = false;
        let current: Drag | null = null;
        const onMove = (ev: globalThis.PointerEvent) => {
          if (!moved && Math.abs(ev.clientY - startY) < 5) return;
          if (!moved) {
            moved = true;
            if (state.current.view.sorts.length) {
              notifications.show({ message: t("database.reorderNeedsNoSort") });
            }
          }
          if (state.current.view.sorts.length) return;
          const body = bodyRef.current?.getBoundingClientRect();
          const scroller = scrollRef.current;
          if (!body || !scroller) return;
          const count = state.current.rows.length;
          const y = ev.clientY - body.top;
          const index = clamp(Math.floor(y / ROW_HEIGHT), 0, count - 1);
          const place = y - index * ROW_HEIGHT < ROW_HEIGHT / 2 ? "before" : "after";
          current = { rowId, index, place };
          setDrag(current);
          const box = scroller.getBoundingClientRect();
          if (ev.clientY < box.top + HEADER_HEIGHT + 16) scroller.scrollTop -= 12;
          else if (ev.clientY > box.bottom - 16) scroller.scrollTop += 12;
        };
        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("pointercancel", onUp);
          if (!moved) return;
          justDragged.current = true;
          setTimeout(() => (justDragged.current = false), 50);
          setDrag(null);
          const target = current && state.current.rows[current.index];
          if (current && target && target.id !== rowId) {
            const { editor, getPos } = latest.current;
            moveRow(editor, getPos, rowId, target.id, current.place);
          }
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
      },
      menu: (rowId) => {
        if (rowId && justDragged.current) return;
        setMenuRow(rowId);
      },
      insertBelow: (rowId) => {
        setMenuRow(null);
        newRow(rowId);
      },
      remove: (rowId) => {
        setMenuRow(null);
        const { editor, getPos } = latest.current;
        removeRow(editor, getPos, rowId);
      },
    }),
    [],
  );

  const columnActions = useMemo<ColumnActions>(
    () => ({
      rename: (id, name) => {
        const { editor, getPos } = latest.current;
        renameColumn(editor, getPos, id, name);
      },
      retype: (id, type: ColumnType) => {
        const { editor, getPos } = latest.current;
        const plan = previewRetype(editor, getPos, id, type);
        const column = state.current.columns.find((c) => c.id === id);
        if (!plan || !column) return;
        const apply = () => retypeColumn(latest.current.editor, latest.current.getPos, id, type);
        if (!plan.changed) return apply();
        modals.openConfirmModal({
          title: t("database.column.confirmRetype.title"),
          children: (
            <Text size="sm">
              {t("database.column.confirmRetype.body", {
                name: column.name,
                type: typeLabel(t, type),
                changed: plan.changed,
                cleared: plan.cleared,
              })}
            </Text>
          ),
          labels: { confirm: t("database.column.confirmRetype.confirm"), cancel: t("database.cancel") },
          confirmProps: { color: "orange" },
          onConfirm: apply,
        });
      },
      sort: (id, direction) => setViewRef.current(withSort(state.current.view, { column: id, direction })),
      filter: (id) => {
        const column = state.current.columns.find((c) => c.id === id);
        if (!column) return;
        const view = state.current.view;
        setViewRef.current({ ...view, filters: [...view.filters, newFilter(column)] });
        setPanel("filter");
      },
      editOptions: (id) => setOptionsFor(id),
      insert: (id, side) => {
        const { editor, getPos } = latest.current;
        const name = uniqueColumnName(state.current.columns, t("database.column.new"));
        addColumn(editor, getPos, { name, type: "text" }, { columnId: id, side });
      },
      move: (id, target, place) => {
        const { editor, getPos } = latest.current;
        moveColumn(editor, getPos, id, target, place);
      },
      remove: (id) => {
        const column = state.current.columns.find((c) => c.id === id);
        if (!column) return;
        modals.openConfirmModal({
          title: t("database.column.confirmDelete.title"),
          children: <Text size="sm">{t("database.column.confirmDelete.body", { name: column.name })}</Text>,
          labels: { confirm: t("database.delete"), cancel: t("database.cancel") },
          confirmProps: { color: "red" },
          onConfirm: () => {
            try {
              removeColumn(latest.current.editor, latest.current.getPos, id);
            } catch (error) {
              if (!(error instanceof DatabaseError)) throw error;
              notifications.show({ color: "red", message: error.message });
            }
          },
        });
      },
      resize: (id, width, done) => {
        if (!done) return setLiveWidth({ id, width: Math.max(60, Math.min(800, width)) });
        setLiveWidth(null);
        const { editor, getPos } = latest.current;
        setColumnWidth(editor, getPos, id, width);
      },
    }),
    [],
  );
  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== scrollRef.current) return;
    const { active, editing, editable } = state.current;
    if (editing) return;
    const mod = event.ctrlKey || event.metaKey;
    const { editor } = latest.current;
    if (mod && (event.key === "z" || event.key === "Z" || event.key === "y")) {
      event.preventDefault();
      const redo = event.key === "y" || event.shiftKey;
      if (redo) editor.commands.redo();
      else editor.commands.undo();
      return;
    }
    const moves: Record<string, Move> = {
      ArrowUp: "up",
      ArrowDown: "down",
      ArrowLeft: "left",
      ArrowRight: "right",
    };
    if (moves[event.key] !== undefined && !mod) {
      event.preventDefault();
      moveActive(moves[event.key]);
      return;
    }
    if (event.key === "Tab" && active) {
      event.preventDefault();
      moveActive(event.shiftKey ? "left" : "right");
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setActive(null);
      const pos = latest.current.getPos();
      if (typeof pos === "number") editor.chain().setNodeSelection(pos).focus().run();
      return;
    }
    if (!active || !editable) return;
    const { column } = valueAt(active);
    if (!column) return;
    if (event.key === "Enter" || event.key === "F2" || (event.key === " " && column.type === "checkbox")) {
      event.preventDefault();
      startEdit(active);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      writeCell(active.rowId, column, null);
      return;
    }
    if (event.key.length === 1 && !mod && !event.altKey && column.type !== "checkbox") {
      event.preventDefault();
      startEdit(active, column.type === "date" ? undefined : event.key);
    }
  };

  const onCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    const { active, editing } = state.current;
    if (event.target !== scrollRef.current || !active || editing) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", cellText(valueAt(active).value));
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const { active, editing, editable } = state.current;
    if (event.target !== scrollRef.current || !active || editing) return;
    event.preventDefault();
    if (!editable) return;
    const { column } = valueAt(active);
    if (!column) return;
    const text = event.clipboardData.getData("text/plain").replace(/[\r\n]+$/, "");
    try {
      writeCell(active.rowId, column, toCellValue(column, text));
    } catch (error) {
      if (!(error instanceof DatabaseError)) throw error;
      notifications.show({ color: "red", message: t("database.pasteFailed", { message: error.message }) });
    }
  };

  const visibleIds = rows.map((r) => r.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someSelected = !allSelected && visibleIds.some((id) => selected.has(id));
  const optionsColumn = columns.find((c) => c.id === optionsFor) ?? null;

  return (
    <NodeViewWrapper
      className={classes.database}
      contentEditable={false}
      data-database-id={data.id}
    >
      <div className={classes.top}>
        <input
          className={classes.title}
          defaultValue={data.title}
          key={data.title}
          placeholder={t("database.untitled")}
          readOnly={!editable}
          onBlur={(e) => setDatabaseTitle(editor, getPos, e.currentTarget.value.trim())}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              e.currentTarget.value = data.title;
              e.currentTarget.blur();
            }
          }}
          aria-label={t("database.titleLabel")}
        />
        <ViewButtons columns={columns} view={view} setView={setView} panel={panel} setPanel={setPanel} />
      </div>
      <ViewChips columns={columns} view={view} setView={setView} setPanel={setPanel} />
      {isLocal && (
        <Group gap="xs" className={classes.notice}>
          <Text size="xs" c="dimmed">
            {t("database.localView")}
          </Text>
          <Button size="compact-xs" variant="subtle" onClick={resetLocal}>
            {t("database.resetView")}
          </Button>
        </Group>
      )}
      {selected.size > 0 && editable && (
        <Group gap="xs" className={classes.selectionBar}>
          <Text size="xs">{t("database.selected", { count: selected.size })}</Text>
          <Button
            size="compact-xs"
            color="red"
            variant="light"
            leftSection={<IconTrash size={12} />}
            onClick={() => confirmRemoveRows([...selected])}
          >
            {t("database.deleteSelected")}
          </Button>
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            aria-label={t("database.clearSelection")}
            onClick={() => setSelected(new Set())}
          >
            <IconX size={12} />
          </ActionIcon>
        </Group>
      )}
      <div
        ref={scrollRef}
        className={classes.scroll}
        style={{ maxHeight: MAX_BODY_HEIGHT + HEADER_HEIGHT }}
        role="grid"
        aria-label={data.title || t("database.table")}
        aria-rowcount={rows.length}
        tabIndex={0}
        onKeyDown={onGridKeyDown}
        onCopy={onCopy}
        onPaste={onPaste}
      >
        <div className={classes.header} style={{ gridTemplateColumns: template }} role="row">
          <div className={classes.action}>
            {editable && (
              <Checkbox
                size="xs"
                className={classes.headerCheck}
                checked={allSelected}
                indeterminate={someSelected}
                tabIndex={-1}
                aria-label={t("database.selectAll")}
                onChange={() => setSelected(allSelected ? new Set() : new Set(visibleIds))}
              />
            )}
          </div>
          {columns.map((column, i) => (
            <ColumnHeader
              key={column.id}
              column={column}
              left={columns[i - 1] ?? null}
              right={columns[i + 1] ?? null}
              width={widthOf(column)}
              editable={editable}
              actions={columnActions}
            />
          ))}
          {editable && (
            <div className={classes.addColumn}>
              <ActionIcon
                size="sm"
                variant="subtle"
                color="gray"
                aria-label={t("database.column.add")}
                onClick={() => {
                  const last = columns[columns.length - 1];
                  const name = uniqueColumnName(columns, t("database.column.new"));
                  addColumn(editor, getPos, { name, type: "text" }, last ? { columnId: last.id, side: "right" } : undefined);
                }}
              >
                <IconPlus size={14} />
              </ActionIcon>
            </div>
          )}
        </div>
        <div ref={bodyRef} className={classes.body} style={{ height: rows.length * ROW_HEIGHT }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            const isActive = active?.rowId === row.id;
            return (
              <RowView
                key={row.id}
                row={row}
                rowNode={rowNodes.get(row.id)}
                columns={columns}
                template={template}
                editable={editable}
                top={item.start}
                activeColumn={isActive ? active!.columnId : null}
                editing={isActive ? editing : null}
                selected={selected.has(row.id)}
                menuOpen={menuRow === row.id}
                actions={rowActions}
              />
            );
          })}
          {drag && (
            <div
              className={classes.dropLine}
              style={{ top: drag.index * ROW_HEIGHT + (drag.place === "after" ? ROW_HEIGHT : 0) - 1 }}
            />
          )}
        </div>
      </div>
      <div className={classes.footer}>
        {editable ? (
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            leftSection={<IconPlus size={12} />}
            onClick={() => newRow(null)}
          >
            {t("database.newRow")}
          </Button>
        ) : (
          <span />
        )}
        <Group gap="xs">
          {pinnedShown > 0 && (
            <Text size="xs" c="dimmed">
              {t("database.pinnedHint", { count: pinnedShown })}
            </Text>
          )}
          <Text size="xs" c="dimmed" data-testid="database-row-count">
            {filtered
              ? t("database.rowsFiltered", { shown: rows.length, total: data.rows.length })
              : t("database.rows", { count: data.rows.length })}
          </Text>
        </Group>
      </div>
      <OptionsEditor
        column={optionsColumn}
        onClose={() => setOptionsFor(null)}
        onChange={(change) => {
          if (!optionsFor) return;
          const { editor, getPos } = latest.current;
          changeOptions(editor, getPos, optionsFor, change);
        }}
        countUse={(label) =>
          optionsFor ? countOptionUse(latest.current.editor, latest.current.getPos, optionsFor, label) : 0
        }
      />
    </NodeViewWrapper>
  );
}
