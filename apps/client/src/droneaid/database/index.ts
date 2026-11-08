import { IconDatabase } from "@tabler/icons-react";
import {
  DroneaidDatabase,
  DroneaidDatabaseCell,
  DroneaidDatabaseColumn,
  DroneaidDatabaseRow,
} from "@docmost/editor-ext";
import type { SlashMenuItemType } from "@/features/editor/components/slash-menu/types";
import DatabaseView from "./database-view";

/** The database block's editor extensions, with the React table view. */
export const databaseExtensions = [
  DroneaidDatabase.configure({ view: DatabaseView }),
  DroneaidDatabaseColumn,
  DroneaidDatabaseRow,
  DroneaidDatabaseCell,
];

/** Slash-menu entry "Database". */
export const databaseSlashItem: SlashMenuItemType = {
  title: "Database",
  description: "Insert a table of typed rows and columns.",
  searchTerms: ["database", "table", "rows", "columns", "grid", "spreadsheet"],
  icon: IconDatabase,
  command: ({ editor, range }) => {
    editor
      .chain()
      .focus()
      .deleteRange(range)
      .insertDatabase({
        columns: [{ name: "Notes", type: "text" }],
        rows: [{}, {}, {}],
      })
      .run();
  },
};
