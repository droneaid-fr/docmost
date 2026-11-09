import { memo } from "react";
import { Checkbox } from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { CellValue, DatabaseColumn, cellText, valueLabels } from "@docmost/editor-ext";
import { optionColorVars } from "./labels";
import classes from "./database-view.module.css";

/** A cell's value, read-only. Editing happens in cell-editor.tsx. */

export function OptionPill({
  column,
  label,
}: {
  column: DatabaseColumn;
  label: string;
}) {
  const { t } = useTranslation("droneaid");
  const option = column.options.find((o) => o.label === label);
  return (
    <span
      className={classes.pill}
      style={optionColorVars(option?.color)}
      data-unknown={option ? undefined : true}
      title={option ? label : `${label} — ${t("database.options.unknown")}`}
    >
      {label}
    </span>
  );
}

interface CellDisplayProps {
  column: DatabaseColumn;
  value: CellValue;
  editable: boolean;
  onToggle: () => void;
}

function CellDisplayInner({ column, value, editable, onToggle }: CellDisplayProps) {
  const { t } = useTranslation("droneaid");
  switch (column.type) {
    case "checkbox":
      return (
        <div className={classes.center}>
          <Checkbox
            size="xs"
            checked={value === true}
            disabled={!editable}
            tabIndex={-1}
            onChange={() => onToggle()}
            aria-label={column.name}
          />
        </div>
      );
    case "select":
    case "multi-select":
      return (
        <div className={classes.pills}>
          {valueLabels(value).map((label) => (
            <OptionPill key={label} column={column} label={label} />
          ))}
        </div>
      );
    case "link":
      return (
        <div className={classes.text}>
          <span className={classes.ellipsis}>{cellText(value)}</span>
          {typeof value === "string" && (
            <a
              className={classes.linkOpen}
              href={value}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t("database.openLink")}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <IconExternalLink size={14} />
            </a>
          )}
        </div>
      );
    default:
      return (
        <div
          className={classes.text}
          data-type={column.type}
          data-title={column.type === "title" || undefined}
        >
          <span className={classes.ellipsis}>{cellText(value)}</span>
        </div>
      );
  }
}

export const CellDisplay = memo(CellDisplayInner);
