import { Button, Indicator, Popover } from "@mantine/core";
import { IconLanguage } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  ShareTranslationsPanel,
  usePageTranslationsQuery,
} from "./share-translations-panel.tsx";

/**
 * "Translations" button beside Share in the page header, shown only while
 * the feature is on and the page is shared to the web. (Core's share menu is
 * an EE component we may not edit, so the panel sits in its own popover.)
 * The dot marks a translation that is out of date or failed.
 */
export function PageTranslationsButton({ pageId }: { pageId?: string }) {
  const { t } = useTranslation("droneaid");
  const { data } = usePageTranslationsQuery(pageId);

  if (!data?.enabled || !data.published) return null;

  const attention = data.translations.some(
    (row) =>
      row.status === "failed" || (row.status === "ready" && row.outOfDate),
  );

  return (
    <Popover width={320} position="bottom-end" withArrow shadow="md">
      <Popover.Target>
        <Button
          size="compact-sm"
          color="dark"
          variant="subtle"
          leftSection={
            <Indicator
              color="orange"
              offset={5}
              disabled={!attention}
              withBorder
            >
              <IconLanguage size={20} stroke={1.5} />
            </Indicator>
          }
          data-testid="page-translations-button"
        >
          {t("translate.button")}
        </Button>
      </Popover.Target>
      <Popover.Dropdown style={{ userSelect: "none" }}>
        <ShareTranslationsPanel pageId={pageId} />
      </Popover.Dropdown>
    </Popover>
  );
}

export default PageTranslationsButton;
