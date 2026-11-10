import React from "react";
import { Group, Text } from "@mantine/core";
import classes from "./auth.module.css";
import SourceCodeLink from "@/droneaid/source/source-code-link.tsx";

type AuthLayoutProps = {
  children: React.ReactNode;
};

export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <>
      <Group justify="center" gap={8} className={classes.logo}>
        <img
          src="/icons/favicon-32x32.png"
          alt="Docmost"
          width={22}
          height={22}
        />
        <Text size="28px" fw={700} style={{ userSelect: "none" }}>
          Docmost
        </Text>
      </Group>
      <main>{children}</main>
      {/* DroneAid: AGPL §13 source offer on every auth page */}
      <Text size="xs" c="dimmed" ta="center" mt="md" mb="md">
        <SourceCodeLink style={{ color: "inherit" }} />
      </Text>
    </>
  );
}
