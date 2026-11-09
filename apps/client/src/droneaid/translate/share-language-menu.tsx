import { Button, Group, Menu } from "@mantine/core";
import { IconCheck, IconLanguage } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { languageKey } from "./languages.ts";
import type { SharedTranslationState } from "./use-shared-translation.ts";

/** `search` with `lang` set, or removed for the original. */
export function searchWithLang(search: string, lang: string | null): string {
  const params = new URLSearchParams(search);
  if (lang) params.set("lang", lang);
  else params.delete("lang");
  const next = params.toString();
  return next ? `?${next}` : "";
}

/** Lets a reader of a shared page switch between its translations. */
export function ShareLanguageMenu({
  translation,
}: {
  translation: SharedTranslationState;
}) {
  const { t } = useTranslation("droneaid");
  const location = useLocation();
  const navigate = useNavigate();
  const { languages, sourceLang, active } = translation;

  if (!languages.length) return null;

  const select = (lang: string | null) =>
    navigate({
      pathname: location.pathname,
      search: searchWithLang(location.search, lang),
      hash: location.hash,
    });

  const name = (lang: string) => t(languageKey(lang));
  const original = sourceLang
    ? t("translate.reader.original", { language: name(sourceLang) })
    : t("translate.reader.originalUnknown");
  const current = active
    ? name(active.lang)
    : sourceLang
      ? name(sourceLang)
      : original;

  return (
    <Group justify="flex-end" mb="xs">
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <Button
            variant="subtle"
            color="gray"
            size="compact-sm"
            leftSection={<IconLanguage size={16} />}
            aria-label={t("translate.reader.label")}
            data-testid="share-language-menu"
          >
            {current}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            onClick={() => select(null)}
            rightSection={!active ? <IconCheck size={14} /> : null}
            data-testid="share-language-original"
          >
            {original}
          </Menu.Item>
          {languages.map((lang) => (
            <Menu.Item
              key={lang}
              onClick={() => select(lang)}
              rightSection={
                active?.lang === lang ? <IconCheck size={14} /> : null
              }
              data-testid={`share-language-${lang}`}
            >
              {name(lang)}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}

export default ShareLanguageMenu;
