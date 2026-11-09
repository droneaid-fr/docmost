import { useState } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Popover,
  Select,
  Stack,
  Text,
} from "@mantine/core";
import {
  IconArrowDown,
  IconArrowUp,
  IconArrowsSort,
  IconFilter,
  IconPlus,
  IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  DatabaseColumn,
  DatabaseViewState,
  FILTER_OPS_BY_TYPE,
  FilterRule,
  SortRule,
  newDatabaseId,
} from "@docmost/editor-ext";
import { FilterRuleEditor } from "./filter-editor";
import { filterSummary } from "./labels";
import classes from "./database-view.module.css";

/**
 * Sort and filter controls above the table, and chips for the active rules.
 * The popovers are controlled from the parent so a column menu can open them.
 */

export type ToolbarPanel = "sort" | "filter" | null;

interface Props {
  columns: DatabaseColumn[];
  view: DatabaseViewState;
  setView: (view: DatabaseViewState) => void;
  panel: ToolbarPanel;
  setPanel: (panel: ToolbarPanel) => void;
}

const COMBO = { withinPortal: false } as const;

export function newFilter(column: DatabaseColumn): FilterRule {
  return {
    id: newDatabaseId(),
    column: column.id,
    op: FILTER_OPS_BY_TYPE[column.type][0],
    value: column.type === "checkbox" ? true : null,
  };
}

export function withSort(view: DatabaseViewState, rule: SortRule): DatabaseViewState {
  const others = view.sorts.filter((s) => s.column !== rule.column);
  const index = view.sorts.findIndex((s) => s.column === rule.column);
  const sorts = index >= 0 ? view.sorts.map((s, i) => (i === index ? rule : s)) : [...others, rule];
  return { ...view, sorts };
}

function SortPanel({ columns, view, setView }: Omit<Props, "panel" | "setPanel">) {
  const { t } = useTranslation("droneaid");
  const columnData = (current?: string) =>
    columns
      .filter((c) => c.id === current || !view.sorts.some((s) => s.column === c.id))
      .map((c) => ({ value: c.id, label: c.name }));
  const unused = columns.find((c) => !view.sorts.some((s) => s.column === c.id));
  const update = (index: number, rule: SortRule) =>
    setView({ ...view, sorts: view.sorts.map((s, i) => (i === index ? rule : s)) });

  return (
    <Stack gap="xs">
      {view.sorts.length === 0 && (
        <Text size="xs" c="dimmed">
          {t("database.noSorts")}
        </Text>
      )}
      {view.sorts.map((rule, index) => (
        <Group key={rule.column} gap={6} wrap="nowrap">
          <Select
            size="xs"
            w={150}
            data={columnData(rule.column)}
            value={rule.column}
            allowDeselect={false}
            comboboxProps={COMBO}
            onChange={(id) => id && update(index, { ...rule, column: id })}
            aria-label={t("database.sort")}
          />
          <Select
            size="xs"
            w={130}
            data={[
              { value: "asc", label: t("database.ascending") },
              { value: "desc", label: t("database.descending") },
            ]}
            value={rule.direction}
            allowDeselect={false}
            comboboxProps={COMBO}
            onChange={(d) => d && update(index, { ...rule, direction: d as SortRule["direction"] })}
          />
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={t("database.removeRule")}
            onClick={() => setView({ ...view, sorts: view.sorts.filter((_, i) => i !== index) })}
          >
            <IconX size={14} />
          </ActionIcon>
        </Group>
      ))}
      <Group justify="space-between">
        <Button
          size="compact-xs"
          variant="subtle"
          leftSection={<IconPlus size={12} />}
          disabled={!unused}
          onClick={() =>
            unused && setView({ ...view, sorts: [...view.sorts, { column: unused.id, direction: "asc" }] })
          }
        >
          {t("database.addSort")}
        </Button>
        {view.sorts.length > 0 && (
          <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setView({ ...view, sorts: [] })}>
            {t("database.clearAll")}
          </Button>
        )}
      </Group>
    </Stack>
  );
}

function FilterPanel({ columns, view, setView }: Omit<Props, "panel" | "setPanel">) {
  const { t } = useTranslation("droneaid");
  const update = (rule: FilterRule) =>
    setView({ ...view, filters: view.filters.map((f) => (f.id === rule.id ? rule : f)) });
  return (
    <Stack gap="xs">
      {view.filters.length === 0 ? (
        <Text size="xs" c="dimmed">
          {t("database.noFilters")}
        </Text>
      ) : (
        <Text size="xs" c="dimmed">
          {t("database.filtersAnd")}
        </Text>
      )}
      {view.filters.map((rule) => (
        <FilterRuleEditor
          key={rule.id}
          rule={rule}
          columns={columns}
          onChange={update}
          onRemove={() => setView({ ...view, filters: view.filters.filter((f) => f.id !== rule.id) })}
        />
      ))}
      <Group justify="space-between">
        <Button
          size="compact-xs"
          variant="subtle"
          leftSection={<IconPlus size={12} />}
          disabled={!columns.length}
          onClick={() => setView({ ...view, filters: [...view.filters, newFilter(columns[0])] })}
        >
          {t("database.addFilter")}
        </Button>
        {view.filters.length > 0 && (
          <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setView({ ...view, filters: [] })}>
            {t("database.clearAll")}
          </Button>
        )}
      </Group>
    </Stack>
  );
}

export function ViewButtons({ columns, view, setView, panel, setPanel }: Props) {
  const { t } = useTranslation("droneaid");
  const button = (kind: "sort" | "filter", count: number) => (
    <Popover
      opened={panel === kind}
      onChange={(open) => setPanel(open ? kind : null)}
      position="bottom-end"
      shadow="md"
      width={kind === "filter" ? 460 : 360}
      withinPortal
      zIndex={250}
    >
      <Popover.Target>
        <Button
          size="compact-xs"
          variant={count ? "light" : "subtle"}
          color={count ? "blue" : "gray"}
          leftSection={kind === "sort" ? <IconArrowsSort size={14} /> : <IconFilter size={14} />}
          rightSection={count ? <Badge size="xs" circle>{count}</Badge> : undefined}
          onClick={() => setPanel(panel === kind ? null : kind)}
          aria-label={t(`database.${kind}`)}
        >
          {t(`database.${kind}`)}
        </Button>
      </Popover.Target>
      <Popover.Dropdown className={classes.panel} onMouseDown={(e) => e.stopPropagation()}>
        {kind === "sort" ? (
          <SortPanel columns={columns} view={view} setView={setView} />
        ) : (
          <FilterPanel columns={columns} view={view} setView={setView} />
        )}
      </Popover.Dropdown>
    </Popover>
  );
  return (
    <Group gap={4} wrap="nowrap">
      {button("sort", view.sorts.length)}
      {button("filter", view.filters.length)}
    </Group>
  );
}

/** One chip per active sort and filter. */
export function ViewChips({
  columns,
  view,
  setView,
  setPanel,
}: Omit<Props, "panel">) {
  const { t } = useTranslation("droneaid");
  if (!view.sorts.length && !view.filters.length) return null;
  const byId = new Map(columns.map((c) => [c.id, c]));
  return (
    <div className={classes.chips} role="list">
      {view.sorts.map((rule) => {
        const column = byId.get(rule.column);
        return (
          <span key={`s:${rule.column}`} className={classes.chip} role="listitem" data-kind="sort">
            <button
              type="button"
              className={classes.chipBody}
              title={t(rule.direction === "asc" ? "database.ascending" : "database.descending")}
              onClick={() =>
                setView(withSort(view, { ...rule, direction: rule.direction === "asc" ? "desc" : "asc" }))
              }
            >
              {rule.direction === "asc" ? <IconArrowUp size={12} /> : <IconArrowDown size={12} />}
              {column?.name ?? t("database.deletedColumn")}
            </button>
            <button
              type="button"
              className={classes.chipRemove}
              aria-label={t("database.removeRule")}
              onClick={() => setView({ ...view, sorts: view.sorts.filter((s) => s !== rule) })}
            >
              <IconX size={12} />
            </button>
          </span>
        );
      })}
      {view.filters.map((rule) => (
        <span key={`f:${rule.id}`} className={classes.chip} role="listitem" data-kind="filter">
          <button type="button" className={classes.chipBody} onClick={() => setPanel("filter")}>
            <IconFilter size={12} />
            {filterSummary(t, rule, byId.get(rule.column))}
          </button>
          <button
            type="button"
            className={classes.chipRemove}
            aria-label={t("database.removeRule")}
            onClick={() => setView({ ...view, filters: view.filters.filter((f) => f.id !== rule.id) })}
          >
            <IconX size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}

export function usePanel() {
  return useState<ToolbarPanel>(null);
}
