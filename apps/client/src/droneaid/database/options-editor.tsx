import { useEffect, useState } from "react";
import {
  ActionIcon,
  Button,
  ColorSwatch,
  Group,
  Menu,
  Modal,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  DatabaseColumn,
  DatabaseError,
  OPTION_COLORS,
  OptionColor,
  SelectOption,
  checkOptionRename,
  optionsWith,
} from "@docmost/editor-ext";
import type { OptionChange } from "./column-commands";

/**
 * Edits a select column's options: add, rename (cells follow), recolour and
 * delete (cells using it are cleared, after a confirmation).
 */

interface Props {
  column: DatabaseColumn | null;
  onClose: () => void;
  onChange: (change: OptionChange) => void;
  countUse: (label: string) => number;
}

function OptionRow({
  option,
  options,
  onChange,
  countUse,
}: {
  option: SelectOption;
  options: SelectOption[];
  onChange: (change: OptionChange) => void;
  countUse: (label: string) => number;
}) {
  const { t } = useTranslation("droneaid");
  const [draft, setDraft] = useState(option.label);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(option.label), [option.label]);

  const rename = () => {
    if (draft === option.label) return;
    try {
      const label = checkOptionRename(options, option.label, draft);
      setError(null);
      if (label === option.label) return setDraft(label);
      onChange({
        options: options.map((o) => (o.label === option.label ? { ...o, label } : o)),
        renames: { [option.label]: label },
      });
    } catch (e) {
      if (!(e instanceof DatabaseError)) throw e;
      setError(draft.trim() ? t("database.options.duplicate", { label: draft.trim() }) : e.message);
    }
  };

  const recolor = (color: OptionColor) =>
    onChange({ options: options.map((o) => (o.label === option.label ? { ...o, color } : o)) });

  const remove = () => {
    const apply = () =>
      onChange({
        options: options.filter((o) => o.label !== option.label),
        removed: [option.label],
      });
    const used = countUse(option.label);
    if (!used) return apply();
    modals.openConfirmModal({
      title: t("database.options.confirmDelete.title"),
      children: (
        <Text size="sm">
          {t("database.options.confirmDelete.body", { label: option.label, count: used })}
        </Text>
      ),
      labels: { confirm: t("database.delete"), cancel: t("database.cancel") },
      confirmProps: { color: "red" },
      onConfirm: apply,
    });
  };

  return (
    <Group gap={6} wrap="nowrap" align="flex-start" data-option={option.label}>
      <Menu position="bottom-start" withinPortal={false}>
        <Menu.Target>
          <ActionIcon variant="subtle" aria-label={t("database.options.color")} mt={4}>
            <ColorSwatch size={16} color={`var(--mantine-color-${option.color}-5)`} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          {OPTION_COLORS.map((color) => (
            <Menu.Item
              key={color}
              leftSection={<ColorSwatch size={14} color={`var(--mantine-color-${color}-5)`} />}
              onClick={() => recolor(color)}
            >
              {t(`database.color.${color}`)}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
      <TextInput
        size="xs"
        style={{ flex: 1 }}
        value={draft}
        error={error}
        aria-label={option.label}
        onChange={(e) => {
          setDraft(e.currentTarget.value);
          setError(null);
        }}
        onBlur={rename}
        onKeyDown={(e) => e.key === "Enter" && rename()}
      />
      <ActionIcon
        variant="subtle"
        color="red"
        mt={4}
        aria-label={t("database.options.delete")}
        onClick={remove}
      >
        <IconTrash size={14} />
      </ActionIcon>
    </Group>
  );
}

export function OptionsEditor({ column, onClose, onChange, countUse }: Props) {
  const { t } = useTranslation("droneaid");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const options = column?.options ?? [];

  const add = () => {
    const label = draft.trim();
    if (!label || !column) return;
    if (options.some((o) => o.label === label)) {
      setError(t("database.options.duplicate", { label }));
      return;
    }
    onChange({ options: optionsWith(options, [label]) });
    setDraft("");
  };

  return (
    <Modal
      opened={!!column}
      onClose={onClose}
      title={column ? t("database.options.title", { name: column.name }) : ""}
      size="sm"
    >
      <Stack gap="xs">
        {options.length === 0 && (
          <Text size="sm" c="dimmed">
            {t("database.options.empty")}
          </Text>
        )}
        {options.map((option) => (
          <OptionRow
            key={option.label}
            option={option}
            options={options}
            onChange={onChange}
            countUse={countUse}
          />
        ))}
        <Group gap={6} wrap="nowrap" align="flex-start">
          <TextInput
            size="xs"
            style={{ flex: 1 }}
            value={draft}
            error={error}
            placeholder={t("database.options.placeholder")}
            aria-label={t("database.options.add")}
            onChange={(e) => {
              setDraft(e.currentTarget.value);
              setError(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <Button size="xs" leftSection={<IconPlus size={12} />} onClick={add} disabled={!draft.trim()}>
            {t("database.options.add")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
