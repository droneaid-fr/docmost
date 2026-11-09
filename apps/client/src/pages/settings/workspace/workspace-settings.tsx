import SettingsTitle from "@/components/settings/settings-title.tsx";
import WorkspaceNameForm from "@/features/workspace/components/settings/components/workspace-name-form";
import WorkspaceIcon from "@/features/workspace/components/settings/components/workspace-icon.tsx";
import { useTranslation } from "react-i18next";
import { isBetaPublicSpaces, isCloud } from "@/lib/config.ts";
import ManageHostname from "@/ee/components/manage-hostname.tsx";
import { Divider } from "@mantine/core";
import WorkspaceDefaultPageEditMode from "@/features/workspace/components/settings/components/workspace-default-page-edit-mode.tsx";
import WorkspaceDefaultLanguage from "@/features/workspace/components/settings/components/workspace-default-language.tsx";
import AllowPublicSpaces from "@/features/workspace/components/settings/components/allow-public-spaces.tsx";
import { DocumentTitle } from "@/components/ui/document-title.tsx";

export default function WorkspaceSettings() {
  const { t } = useTranslation();
  return (
    <>
      <DocumentTitle title="Workspace Settings" />
      <SettingsTitle title={t("General")} />
      <WorkspaceIcon />
      <WorkspaceNameForm />

      {isBetaPublicSpaces() && (
        <>
          <Divider my="md" />
          <AllowPublicSpaces />
        </>
      )}

      {isCloud() && (
        <>
          <Divider my="md" />
          <ManageHostname />
        </>
      )}

      <Divider my="md" />
      <WorkspaceDefaultLanguage />

      <Divider my="md" />
      <WorkspaceDefaultPageEditMode />
    </>
  );
}
