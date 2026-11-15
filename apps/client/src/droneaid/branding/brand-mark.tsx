import { Box } from "@mantine/core";
import { BRAND_MARK_DARK, BRAND_MARK_LIGHT } from "./brand.ts";

interface BrandMarkProps {
  size: number;
  /** Empty when a visible app name sits next to the mark. */
  alt?: string;
}

/**
 * The DroneAid logomark. Its outlines are near-black, so the dark colour scheme gets a
 * variant with white outlines; Mantine hides whichever does not match the app's scheme.
 */
export function BrandMark({ size, alt = "" }: BrandMarkProps) {
  return (
    <>
      <Box
        component="img"
        src={BRAND_MARK_LIGHT}
        alt={alt}
        width={size}
        height={size}
        darkHidden
        data-testid="droneaid-brand-mark"
      />
      <Box
        component="img"
        src={BRAND_MARK_DARK}
        alt={alt}
        width={size}
        height={size}
        lightHidden
        data-testid="droneaid-brand-mark-dark"
      />
    </>
  );
}

export default BrandMark;
