import { Group, Text } from "@mantine/core";
import { APP_NAME } from "./brand.ts";
import { BrandMark } from "./brand-mark.tsx";

interface BrandLogoProps {
  markSize: number;
  textSize: string;
  fw?: number;
  /** Mantine breakpoint below which only the mark shows (give the parent an aria-label). */
  nameVisibleFrom?: string;
}

/** Logomark plus "DroneAid Base", used in the app header and on auth pages. */
export function BrandLogo({
  markSize,
  textSize,
  fw = 600,
  nameVisibleFrom,
}: BrandLogoProps) {
  return (
    <Group gap={8} wrap="nowrap" style={{ userSelect: "none" }}>
      <BrandMark size={markSize} />
      <Text size={textSize} fw={fw} visibleFrom={nameVisibleFrom}>
        {APP_NAME}
      </Text>
    </Group>
  );
}

export default BrandLogo;
