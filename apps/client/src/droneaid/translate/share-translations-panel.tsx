import {
  Badge,
  Button,
  Checkbox,
  Group,
  NativeSelect,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getPageTranslations,
  PageTranslation,
  PageTranslations,
  setPageTranslations,
  updatePageTranslations,
} from "./translate-api.ts";
import { DEFAULT_SOURCE_LANG, languageKey } from "./languages.ts";

/** How often the panel re-reads statuses while a translation runs. */
const POLL_MS = 5000;
const IDLE_POLL_MS = 15000;

const STATUS_COLOR: Record<string, string> = {
  pending: "gray",
  running: "blue",
  ready: "green",
  failed: "red",
};

function StatusBadge({ row }: { row: PageTranslation }) {
  const { t } = useTranslation("droneaid");
  const outOfDate = row.status === "ready" && row.outOfDate;
  const badge = (
    <Badge
      size="xs"
      variant="light"
      color={outOfDate ? "orange" : (STATUS_COLOR[row.status] ?? "gray")}
      data-testid={`translation-status-${row.lang}`}
      data-status={outOfDate ? "out-of-date" : row.status}
    >
      {outOfDate
        ? t("translate.status.outOfDate")
        : t(`translate.status.${row.status}`)}
    </Badge>
  );
  return row.error ? (
    <Tooltip label={row.error} multiline w={260} withinPortal={false}>
      {badge}
    </Tooltip>
  ) : (
    badge
  );
}

export const pageTranslationsKey = (pageId: string) => [
  "droneaid",
  "page-translations",
  pageId,
];

/**
 * Translation state of a page. Re-read every 5 s while a translation runs,
 * and every 15 s otherwise so publishing in the share menu shows up.
 */
export function usePageTranslationsQuery(pageId: string | undefined) {
  return useQuery({
    queryKey: pageTranslationsKey(pageId),
    queryFn: () => getPageTranslations(pageId),
    enabled: !!pageId,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.translations?.some((r) =>
        ["pending", "running"].includes(r.status),
      )
        ? POLL_MS
        : IDLE_POLL_MS,
  });
}

/**
 * Machine translations offered to readers of the public page. Shown once the page is public; hidden while the server has the
 * feature off. Only users who can share the page can change it.
 */
export function ShareTranslationsPanel({ pageId }: { pageId?: string }) {
  const { t } = useTranslation("droneaid");
  const queryClient = useQueryClient();
  const { data } = usePageTranslationsQuery(pageId);
  // The source chosen before any target is ticked (nothing to save yet).
  const [chosenSource, setChosenSource] = useState<string | null>(null);

  const onError = (error: any) =>
    notifications.show({
      color: "red",
      title: t("translate.saveFailed"),
      message:
        error?.response?.data?.message ?? String(error?.message ?? error),
    });
  const onSuccess = (next: PageTranslations) =>
    queryClient.setQueryData(pageTranslationsKey(pageId), next);

  const save = useMutation({
    mutationFn: (input: Parameters<typeof setPageTranslations>[0]) =>
      setPageTranslations(input),
    onSuccess,
    onError,
  });
  const refresh = useMutation({
    mutationFn: () => updatePageTranslations(pageId),
    onSuccess,
    onError,
  });

  if (!data?.enabled || !data.published) return null;

  const rows = data.translations;
  const sourceLang = data.sourceLang ?? chosenSource ?? DEFAULT_SOURCE_LANG;
  const selected = new Set(rows.map((row) => row.lang));
  const busy = rows.some((r) => ["pending", "running"].includes(r.status));
  const disabled = !data.canManage || save.isPending;

  const submit = (nextSource: string, languages: string[]) =>
    save.mutate({
      pageId,
      sourceLang: nextSource,
      languages: languages.filter((lang) => lang !== nextSource),
    });

  return (
    <Stack gap={6} data-testid="share-translations">
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm">{t("translate.label")}</Text>
        <Button
          size="compact-xs"
          variant="light"
          disabled={disabled || !rows.length || busy}
          loading={refresh.isPending}
          onClick={() => refresh.mutate()}
          data-testid="share-translations-update"
        >
          {t("translate.update")}
        </Button>
      </Group>
      <NativeSelect
        size="xs"
        label={t("translate.source")}
        value={sourceLang}
        disabled={disabled}
        onChange={(e) => {
          const next = e.currentTarget.value;
          setChosenSource(next);
          if (rows.length) submit(next, [...selected]);
        }}
        data={data.languages.map((lang) => ({
          value: lang,
          label: t(languageKey(lang)),
        }))}
        data-testid="share-translations-source"
      />
      {data.languages
        .filter((lang) => lang !== sourceLang)
        .map((lang) => {
          const row = rows.find((r) => r.lang === lang);
          return (
            <Group key={lang} justify="space-between" wrap="nowrap" gap="xs">
              <Checkbox
                size="xs"
                label={t(languageKey(lang))}
                checked={selected.has(lang)}
                disabled={disabled}
                onChange={(e) => {
                  const checked = e.currentTarget.checked;
                  submit(
                    sourceLang,
                    checked
                      ? [...selected, lang]
                      : [...selected].filter((l) => l !== lang),
                  );
                }}
                data-testid={`share-translation-${lang}`}
              />
              {row && <StatusBadge row={row} />}
            </Group>
          );
        })}
      <Text size="xs" c="dimmed">
        {t("translate.hint")}
      </Text>
    </Stack>
  );
}

export default ShareTranslationsPanel;
