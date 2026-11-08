import { DatabaseColumn, DatabaseData, SelectOption } from "./types";
import { cellText, isColumnType, readOptions, toCellValue } from "./values";
import { newDatabaseId, withUsedOptions } from "./model";
import { DATABASE_HTML_TYPE, databaseToHtml, readDatabaseElement } from "./html";

/**
 * Markdown form: a marker comment with the schema and row ids, then a GFM
 * table of the values. Any Markdown reader sees a plain table; our marked
 * extension turns marker + table back into the block (round trip).
 *
 *   <!-- droneaid:database {"id":..,"title":..,"columns":[..],"rows":[ids]} -->
 *   | Name | Status |
 *   | --- | --- |
 *   | Alpha | Done |
 *
 * Limits: rows match ids by position; newlines in a cell become spaces; a
 * multi-select label containing a comma splits in two.
 */

const MARKER = "droneaid:database";

interface MarkerMeta {
  id: string;
  title: string;
  columns: { id: string; name: string; type: string; options?: SelectOption[]; width?: number }[];
  rows: string[];
}

/** JSON safe inside an HTML comment (no "<", ">" or "--" sequences). */
function commentJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/-(?=-)/g, "\\u002d");
}

export function escapeTableCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\s*[\r\n]+\s*/g, " ");
}

/** Splits a GFM table line into raw cell texts (escaped pipes kept). */
export function splitTableLine(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) {
      const next = text[i + 1];
      current += next === "|" || next === "\\" ? next : c + next;
      i++;
    } else if (c === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += c;
    }
  }
  cells.push(current.trim());
  return cells;
}

export function databaseToMarkdown(data: DatabaseData): string {
  const meta: MarkerMeta = {
    id: data.id,
    title: data.title,
    columns: data.columns.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      ...(c.options.length ? { options: c.options } : {}),
      ...(c.width ? { width: c.width } : {}),
    })),
    rows: data.rows.map((r) => r.id),
  };
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const lines = [
    `<!-- ${MARKER} ${commentJson(meta)} -->`,
    line(data.columns.map((c) => escapeTableCell(c.name) || " ")),
    line(data.columns.map(() => "---")),
    ...data.rows.map((row) =>
      line(data.columns.map((c) => escapeTableCell(cellText(row.cells[c.id] ?? null)))),
    ),
  ];
  return lines.join("\n");
}

const MARKER_RE = new RegExp(
  `^ {0,3}<!-- ${MARKER} (\\{[^\\n]*?\\}) -->[ \\t]*(?:\\n|$)`,
);
const TABLE_LINE_RE = /^ {0,3}\|[^\n]*(?:\n|$)/;

function readMeta(text: string): MarkerMeta | null {
  try {
    const meta = JSON.parse(text);
    if (!meta || typeof meta !== "object" || !Array.isArray(meta.columns)) return null;
    return {
      id: typeof meta.id === "string" ? meta.id : newDatabaseId(),
      title: typeof meta.title === "string" ? meta.title : "",
      columns: meta.columns.filter((c: any) => c && typeof c.id === "string"),
      rows: Array.isArray(meta.rows) ? meta.rows.map(String) : [],
    };
  } catch {
    return null;
  }
}

/**
 * Parses marker + table at the start of `src`. Returns the database and the
 * consumed source, or null when `src` does not start with a marker.
 */
export function parseDatabaseMarkdown(
  src: string,
): { data: DatabaseData; raw: string } | null {
  const marker = MARKER_RE.exec(src);
  if (!marker) return null;
  const meta = readMeta(marker[1]);
  if (!meta) return null;
  let raw = marker[0];
  const lines: string[] = [];
  for (;;) {
    const match = TABLE_LINE_RE.exec(src.slice(raw.length));
    if (!match) break;
    raw += match[0];
    lines.push(match[0].replace(/\n$/, ""));
  }
  const [header, , ...body] = lines;
  const names = header ? splitTableLine(header) : [];
  const columns: DatabaseColumn[] = meta.columns.map((c, i) => {
    const type = isColumnType(c.type) ? c.type : "text";
    return {
      id: c.id,
      name: names.length === meta.columns.length ? names[i] : String(c.name ?? ""),
      type,
      options: type === "select" || type === "multi-select" ? readOptions(c.options) : [],
      width: Number(c.width) > 0 ? Number(c.width) : null,
    };
  });
  const rows = body.map((line, index) => {
    const texts = splitTableLine(line);
    const cells: DatabaseData["rows"][number]["cells"] = {};
    columns.forEach((column, i) => {
      const value = toCellValue(column, texts[i] ?? "", true);
      if (value !== null) cells[column.id] = value;
    });
    return { id: meta.rows[index] ?? newDatabaseId(), cells };
  });
  return { data: withUsedOptions({ id: meta.id, title: meta.title, columns, rows }), raw };
}

/** marked block extension: marker + table -> the block's HTML. */
export const databaseMarkedExtension = {
  name: "droneaidDatabase",
  level: "block" as const,
  start(src: string) {
    const index = src.indexOf(`<!-- ${MARKER} `);
    return index < 0 ? undefined : index;
  },
  tokenizer(src: string) {
    const parsed = parseDatabaseMarkdown(src);
    if (!parsed) return undefined;
    return { type: "droneaidDatabase", raw: parsed.raw, data: parsed.data };
  },
  renderer(token: any) {
    return databaseToHtml(token.data);
  },
};

/** Turndown plugin: the block's HTML -> marker + table. */
export function databaseTurndown(turndownService: any) {
  turndownService.addRule("droneaidDatabase", {
    filter: (node: HTMLElement) =>
      node.nodeName === "DIV" && node.getAttribute("data-type") === DATABASE_HTML_TYPE,
    replacement: (_content: string, node: HTMLElement) =>
      `\n\n${databaseToMarkdown(readDatabaseElement(node))}\n\n`,
  });
}
