import { DragEvent, PointerEvent, memo, useEffect, useRef, useState } from "react";
import { Divider, Popover, Select, Stack, TextInput, UnstyledButton } from "@mantine/core";
import {
  IconArrowLeft,
  IconArrowRight,
  IconArrowDown,
  IconArrowUp,
  IconColumnInsertLeft,
  IconColumnInsertRight,
  IconFilter,
  IconList,
  IconTrash,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { ColumnType, DatabaseColumn } from "@docmost/editor-ext";
import { TYPE_ICONS, retypeOptions } from "./labels";
import classes from "./database-view.module.css";

/**
 * A column header: name and type icon, a menu (click), a resize handle on
 * the right edge and drag-to-reorder (editors only). Readers get sort and
 * filter only.
 */

export interface ColumnActions {
  rename: (columnId: string, name: string) => void;
  retype: (columnId: string, type: ColumnType) => void;
  sort: (columnId: string, direction: "asc" | "desc") => void;
  filter: (columnId: string) => void;
  editOptions: (columnId: string) => void;
  insert: (columnId: string, side: "left" | "right") => void;
  move: (columnId: string, targetId: string, place: "before" | "after") => void;
  remove: (columnId: string) => void;
  resize: (columnId: string, width: number, done: boolean) => void;
}

interface Props {
  column: DatabaseColumn;
  left: DatabaseColumn | null;
  right: DatabaseColumn | null;
  width: number;
  editable: boolean;
  actions: ColumnActions;
}

function MenuButton({
  icon: Icon,
  label,
  onClick,
  danger,
  disabled,
}: {
  icon: typeof IconTrash;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <UnstyledButton
      className={classes.menuItem}
      data-danger={danger || undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={14} />
      <span>{label}</span>
    </UnstyledButton>
  );
}

const DRAG_TYPE = "application/x-droneaid-column";

function ColumnHeaderInner({ column, left, right, width, editable, actions }: Props) {
  const { t } = useTranslation("droneaid");
  const [opened, setOpened] = useState(false);
  const [name, setName] = useState(column.name);
  const [dropSide, setDropSide] = useState<"before" | "after" | null>(null);
  const resizing = useRef<{ startX: number; startWidth: number } | null>(null);
  useEffect(() => setName(column.name), [column.name]);

  const Icon = TYPE_ICONS[column.type];
  const isTitle = column.type === "title";
  const run = (fn: () => void) => () => {
    setOpened(false);
    fn();
  };
  const commitName = () => {
    if (name.trim() && name.trim() !== column.name) actions.rename(column.id, name);
    else setName(column.name);
  };

  const onResizeDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizing.current = { startX: e.clientX, startWidth: width };
  };
  const onResizeMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = resizing.current;
    if (r) actions.resize(column.id, r.startWidth + e.clientX - r.startX, false);
  };
  const onResizeUp = (e: PointerEvent<HTMLDivElement>) => {
    const r = resizing.current;
    resizing.current = null;
    if (r) actions.resize(column.id, r.startWidth + e.clientX - r.startX, true);
  };

  const sideOf = (e: DragEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return e.clientX < box.left + box.width / 2 ? "before" : "after";
  };

  return (
    <div
      className={classes.headerCell}
      role="columnheader"
      data-column-id={column.id}
      data-drop={dropSide ?? undefined}
      draggable={editable}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, column.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        setDropSide(sideOf(e));
      }}
      onDragLeave={() => setDropSide(null)}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(DRAG_TYPE);
        setDropSide(null);
        if (!id) return;
        e.preventDefault();
        actions.move(id, column.id, sideOf(e));
      }}
    >
      <Popover
        opened={opened}
        onChange={setOpened}
        position="bottom-start"
        width={240}
        shadow="md"
        zIndex={250}
      >
        <Popover.Target>
          <UnstyledButton
            className={classes.headerButton}
            onClick={() => setOpened((o) => !o)}
            title={column.name}
            aria-label={`${column.name} — ${t("database.column.menu")}`}
          >
            <Icon size={14} className={classes.headerIcon} />
            <span className={classes.ellipsis}>{column.name}</span>
          </UnstyledButton>
        </Popover.Target>
        <Popover.Dropdown p={6} onMouseDown={(e) => e.stopPropagation()}>
          <Stack gap={2}>
            {editable && (
              <>
                <TextInput
                  size="xs"
                  value={name}
                  aria-label={t("database.column.name")}
                  onChange={(e) => setName(e.currentTarget.value)}
                  onBlur={commitName}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") {
                      commitName();
                      setOpened(false);
                    }
                  }}
                />
                <Select
                  size="xs"
                  mt={4}
                  label={t("database.column.type")}
                  data={retypeOptions(t)}
                  value={isTitle ? null : column.type}
                  placeholder={isTitle ? t("database.type.title") : undefined}
                  disabled={isTitle}
                  description={isTitle ? t("database.column.titleLocked") : undefined}
                  allowDeselect={false}
                  comboboxProps={{ withinPortal: false }}
                  onChange={(type) => {
                    if (!type || type === column.type) return;
                    setOpened(false);
                    actions.retype(column.id, type as ColumnType);
                  }}
                />
                <Divider my={4} />
              </>
            )}
            <MenuButton icon={IconArrowUp} label={t("database.column.sortAsc")} onClick={run(() => actions.sort(column.id, "asc"))} />
            <MenuButton icon={IconArrowDown} label={t("database.column.sortDesc")} onClick={run(() => actions.sort(column.id, "desc"))} />
            <MenuButton icon={IconFilter} label={t("database.column.filter")} onClick={run(() => actions.filter(column.id))} />
            {editable && (
              <>
                {(column.type === "select" || column.type === "multi-select") && (
                  <MenuButton icon={IconList} label={t("database.column.editOptions")} onClick={run(() => actions.editOptions(column.id))} />
                )}
                <Divider my={4} />
                <MenuButton icon={IconColumnInsertLeft} label={t("database.column.insertLeft")} onClick={run(() => actions.insert(column.id, "left"))} />
                <MenuButton icon={IconColumnInsertRight} label={t("database.column.insertRight")} onClick={run(() => actions.insert(column.id, "right"))} />
                <MenuButton
                  icon={IconArrowLeft}
                  label={t("database.column.moveLeft")}
                  disabled={!left}
                  onClick={run(() => left && actions.move(column.id, left.id, "before"))}
                />
                <MenuButton
                  icon={IconArrowRight}
                  label={t("database.column.moveRight")}
                  disabled={!right}
                  onClick={run(() => right && actions.move(column.id, right.id, "after"))}
                />
                <Divider my={4} />
                <MenuButton
                  icon={IconTrash}
                  label={t("database.column.delete")}
                  danger
                  disabled={isTitle}
                  onClick={run(() => actions.remove(column.id))}
                />
              </>
            )}
          </Stack>
        </Popover.Dropdown>
      </Popover>
      {editable && (
        <div
          className={classes.resizer}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("database.column.resize")}
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
        />
      )}
    </div>
  );
}

export const ColumnHeader = memo(ColumnHeaderInner);
