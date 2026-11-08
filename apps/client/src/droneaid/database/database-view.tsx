import { memo, useCallback, useMemo, useRef } from "react";
import { NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ActionIcon, Button, Text } from "@mantine/core";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import {
  CellValue,
  DATABASE_ROW_NODE,
  DatabaseColumn,
  DatabaseRow,
  readDatabaseNode,
} from "@docmost/editor-ext";
import { CellEditor } from "./cell-editor";
import { addRow, removeRow, setCellValue, setDatabaseTitle } from "./commands";
import classes from "./database-view.module.css";

/**
 * Table view of a database block. The node has no contentDOM: this view
 * draws everything from the node. Rows are virtualised and memoised on the
 * identity of their ProseMirror node, so an edit re-renders one row.
 * S4b adds sort, filter and column management on top of this.
 */

const ROW_HEIGHT = 34;
const MAX_BODY_HEIGHT = 520;
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
const ACTION_WIDTH = 32;

type CellChange = (rowId: string, column: DatabaseColumn, value: CellValue) => void;

interface RowProps {
  row: DatabaseRow;
  rowNode: PMNode;
  columns: DatabaseColumn[];
  template: string;
  editable: boolean;
  top: number;
  onCellChange: CellChange;
  onRemove: (rowId: string) => void;
}

const DatabaseRowView = memo(
  function DatabaseRowView({
    row,
    columns,
    template,
    editable,
    top,
    onCellChange,
    onRemove,
  }: RowProps) {
    return (
      <div
        className={classes.row}
        style={{ gridTemplateColumns: template, transform: `translateY(${top}px)` }}
        data-row-id={row.id}
        role="row"
      >
        <div className={classes.action}>
          {editable && (
            <ActionIcon
              size="xs"
              variant="subtle"
              color="gray"
              className={classes.rowDelete}
              onClick={() => onRemove(row.id)}
              aria-label="Delete row"
            >
              <IconTrash size={12} />
            </ActionIcon>
          )}
        </div>
        {columns.map((column) => (
          <div key={column.id} className={classes.cell} role="cell" data-column-id={column.id}>
            <CellEditor
              column={column}
              value={row.cells[column.id] ?? null}
              editable={editable}
              onChange={(value) => onCellChange(row.id, column, value)}
            />
          </div>
        ))}
      </div>
    );
  },
  (prev, next) =>
    prev.rowNode === next.rowNode &&
    prev.columns === next.columns &&
    prev.top === next.top &&
    prev.editable === next.editable &&
    prev.template === next.template,
);

export default function DatabaseView(props: NodeViewProps) {
  const { node, editor, getPos } = props;
  const editable = editor.isEditable;

  const data = useMemo(() => readDatabaseNode(node), [node]);
  const rowNodes = useMemo(() => {
    const list: PMNode[] = [];
    node.forEach((child) => {
      if (child.type.name === DATABASE_ROW_NODE) list.push(child);
    });
    return list;
  }, [node]);

  // Stable while the schema is unchanged, so rows stay memoised.
  const columnsKey = JSON.stringify(data.columns);
  const columns = useMemo(() => data.columns, [columnsKey]);
  const template = useMemo(
    () =>
      [ACTION_WIDTH, ...columns.map((c) => c.width ?? DEFAULT_WIDTH[c.type])]
        .map((w) => `${w}px`)
        .join(" "),
    [columns],
  );

  // Handlers read the latest editor state through refs: stable identities.
  const latest = useRef({ editor, getPos });
  latest.current = { editor, getPos };
  const onCellChange = useCallback<CellChange>((rowId, column, value) => {
    const { editor, getPos } = latest.current;
    setCellValue(editor, getPos, rowId, column, value);
  }, []);
  const onRemove = useCallback((rowId: string) => {
    const { editor, getPos } = latest.current;
    removeRow(editor, getPos, rowId);
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: data.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    getItemKey: (index) => data.rows[index]?.id ?? index,
  });

  const bodyHeight = data.rows.length * ROW_HEIGHT;

  return (
    <NodeViewWrapper
      className={classes.database}
      contentEditable={false}
      data-database-id={data.id}
    >
      <input
        className={classes.title}
        defaultValue={data.title}
        key={data.title}
        placeholder="Untitled database"
        readOnly={!editable}
        onBlur={(e) => setDatabaseTitle(editor, getPos, e.currentTarget.value.trim())}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        aria-label="Database title"
      />
      <div
        ref={scrollRef}
        className={classes.scroll}
        style={{ maxHeight: MAX_BODY_HEIGHT + ROW_HEIGHT }}
        role="table"
      >
        <div className={classes.header} style={{ gridTemplateColumns: template }} role="row">
          <div className={classes.action} />
          {columns.map((column) => (
            <div
              key={column.id}
              className={classes.headerCell}
              role="columnheader"
              title={`${column.name} (${column.type})`}
            >
              {column.name}
            </div>
          ))}
        </div>
        <div className={classes.body} style={{ height: bodyHeight }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = data.rows[item.index];
            if (!row) return null;
            return (
              <DatabaseRowView
                key={item.key as string}
                row={row}
                rowNode={rowNodes[item.index]}
                columns={columns}
                template={template}
                editable={editable}
                top={item.start}
                onCellChange={onCellChange}
                onRemove={onRemove}
              />
            );
          })}
        </div>
      </div>
      <div className={classes.footer}>
        {editable && (
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            leftSection={<IconPlus size={12} />}
            onClick={() => {
              addRow(editor, getPos);
              requestAnimationFrame(() =>
                virtualizer.scrollToIndex(data.rows.length, { align: "end" }),
              );
            }}
          >
            New row
          </Button>
        )}
        <Text size="xs" c="dimmed">
          {data.rows.length} {data.rows.length === 1 ? "row" : "rows"}
        </Text>
      </div>
    </NodeViewWrapper>
  );
}
