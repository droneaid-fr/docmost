import { useAppVersion } from "@/features/workspace/queries/workspace-query.ts";
import { isCloud } from "@/lib/config.ts";
import classes from "@/components/settings/settings.module.css";
import { Indicator, Text, Tooltip } from "@mantine/core";
import React from "react";
import semverGt from "semver/functions/gt";
import { useTranslation } from "react-i18next";
// DroneAid: the version badge links our source (AGPL §13), not upstream's releases
import {
  shortCommit,
  sourceCodeUrl,
} from "@/droneaid/source/source-info.ts";
import SourceCodeLink from "@/droneaid/source/source-code-link.tsx";

export default function AppVersion() {
  const { t } = useTranslation();
  const { t: tDroneaid } = useTranslation("droneaid");
  const commit = shortCommit();
  const { data: appVersion } = useAppVersion(!isCloud());
  let hasUpdate = false;
  try {
    hasUpdate =
      appVersion &&
      parseFloat(appVersion.latestVersion) > 0 &&
      semverGt(appVersion.latestVersion, appVersion.currentVersion);
  } catch (err) {
    console.error(err);
  }

  return (
    <div className={classes.text}>
      <Tooltip
        label={t("{{latestVersion}} is available", {
          latestVersion: `v${appVersion?.latestVersion}`,
        })}
        disabled={!hasUpdate}
      >
        <Indicator
          label={t("New update")}
          color="gray"
          inline
          size={16}
          position="middle-end"
          style={{ cursor: "pointer" }}
          disabled={!hasUpdate}
          onClick={() => {
            window.open(sourceCodeUrl(), "_blank", "noreferrer");
          }}
        >
          <Text
            size="sm"
            c="dimmed"
            component="a"
            mr={45}
            href={sourceCodeUrl()}
            target="_blank"
            rel="noreferrer"
          >
            {appVersion?.currentVersion && <>v{appVersion?.currentVersion} · </>}
            {commit
              ? tDroneaid("source.version", { commit })
              : tDroneaid("source.versionDev")}
          </Text>
        </Indicator>
      </Tooltip>
      <Text size="xs" c="dimmed" mt={4}>
        <SourceCodeLink style={{ color: "inherit" }} />
      </Text>
    </div>
  );
}
