import React from "react";
import { Group, Text } from "@mantine/core";
import classes from "./auth.module.css";
import SourceCodeLink from "@/droneaid/source/source-code-link.tsx";
import BrandLogo from "@/droneaid/branding/brand-logo.tsx";

type AuthLayoutProps = {
  children: React.ReactNode;
};

export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <>
      <Group justify="center" gap={8} className={classes.logo}>
        {/* DroneAid: our logo and product name */}
        <BrandLogo markSize={32} textSize="28px" fw={700} />
      </Group>
      <main>{children}</main>
      {/* DroneAid: AGPL §13 source offer on every auth page */}
      <Text size="xs" c="dimmed" ta="center" mt="md" mb="md">
        <SourceCodeLink style={{ color: "inherit" }} />
      </Text>
    </>
  );
}
