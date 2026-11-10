import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { sourceCodeUrl } from "./source-info.ts";

interface Props {
  className?: string;
  style?: CSSProperties;
}

/** "Source code (AGPL-3.0)" link to the exact commit this build was made from. */
export function SourceCodeLink({ className, style }: Props) {
  const { t } = useTranslation("droneaid");
  return (
    <a
      href={sourceCodeUrl()}
      target="_blank"
      rel="noreferrer"
      className={className}
      style={style}
      title={t("source.title")}
      data-testid="droneaid-source-link"
    >
      {t("source.link")}
    </a>
  );
}

export default SourceCodeLink;
