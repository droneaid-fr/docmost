// Shared neutral block shown where a page holds content made by an Enterprise feature.
import { Box, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

export function NotAvailableBlock({ what }: { what: string }) {
  const { t } = useTranslation("droneaid");
  return (
    <Box
      p="md"
      bg="var(--mantine-color-default-hover)"
      style={{ borderRadius: 8 }}
      contentEditable={false}
      data-testid="ee-not-available"
    >
      <Text c="dimmed" size="sm">
        {t("eeStubs.notAvailable", { what })}
      </Text>
    </Box>
  );
}
