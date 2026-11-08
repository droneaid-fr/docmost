import { CellValue, DatabaseColumn, DatabaseData } from "./types";
import { cellText, readCellValue, readOptions, toCellValue } from "./values";
import { newDatabaseId, readColumnAttrs, withUsedOptions } from "./model";

/**
 * HTML form of the block: a wrapper div holding a real <table>, so HTML
 * export, clipboard and Markdown (GFM table) all see the rows. Ids, column
 * types, options and typed values ride on data attributes, so parsing the
 * HTML back restores the block exactly.
 *
 *   <div data-type="droneaid-database" data-id data-title>
 *     <table><thead><tr><th data-column-id data-column-type data-options data-width>Name
 *     <tbody><tr data-row-id><td data-value='json'>text
 */

export const DATABASE_HTML_TYPE = "droneaid-database";

function json(value: unknown): string {
  return JSON.stringify(value);
}

function headerAttrs(column: DatabaseColumn): Record<string, string> {
  const attrs: Record<string, string> = {
    "data-column-id": column.id,
    "data-column-type": column.type,
  };
  if (column.options.length) attrs["data-options"] = json(column.options);
  if (column.width) attrs["data-width"] = String(column.width);
  return attrs;
}

function valueAttrs(value: CellValue): Record<string, string> {
  return value === null ? {} : { "data-value": json(value) };
}

/** ProseMirror DOMOutputSpec (renderHTML). */
export function databaseDomSpec(data: DatabaseData): any {
  return [
    "div",
    {
      "data-type": DATABASE_HTML_TYPE,
      "data-id": data.id,
      "data-title": data.title,
      class: "droneaid-database",
    },
    [
      "table",
      {},
      [
        "thead",
        {},
        ["tr", {}, ...data.columns.map((c) => ["th", headerAttrs(c), c.name])],
      ],
      [
        "tbody",
        {},
        ...data.rows.map((row) => [
          "tr",
          { "data-row-id": row.id },
          ...data.columns.map((c) => {
            const value = row.cells[c.id] ?? null;
            return ["td", valueAttrs(value), cellText(value)];
          }),
        ]),
      ],
    ],
  ];
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function attrString(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .map(([key, value]) => ` ${key}="${escapeHtml(value)}"`)
    .join("");
}

/** The same HTML as databaseDomSpec, as a string (Markdown import). */
export function databaseToHtml(data: DatabaseData): string {
  const head = data.columns
    .map((c) => `<th${attrString(headerAttrs(c))}>${escapeHtml(c.name)}</th>`)
    .join("");
  const body = data.rows
    .map((row) => {
      const cells = data.columns
        .map((c) => {
          const value = row.cells[c.id] ?? null;
          return `<td${attrString(valueAttrs(value))}>${escapeHtml(cellText(value))}</td>`;
        })
        .join("");
      return `<tr data-row-id="${escapeHtml(row.id)}">${cells}</tr>`;
    })
    .join("");
  return (
    `<div data-type="${DATABASE_HTML_TYPE}" data-id="${escapeHtml(data.id)}"` +
    ` data-title="${escapeHtml(data.title)}" class="droneaid-database">` +
    `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
  );
}

function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function directRows(table: Element, section: string): Element[] {
  const rows: Element[] = [];
  for (const child of Array.from(table.children)) {
    const tag = child.nodeName.toLowerCase();
    if (tag === section) {
      rows.push(...Array.from(child.children).filter((r) => r.nodeName.toLowerCase() === "tr"));
    }
  }
  return rows;
}

/**
 * Reads the block back from its HTML (browser DOM, happy-dom or domino).
 * Cells without data-value (hand-written HTML) are parsed from their text.
 */
export function readDatabaseElement(element: Element): DatabaseData {
  const table = Array.from(element.children).find(
    (c) => c.nodeName.toLowerCase() === "table",
  );
  const headRow = table ? directRows(table, "thead")[0] : undefined;
  const bodyRows = table ? directRows(table, "tbody") : [];
  const headers = headRow
    ? Array.from(headRow.children).filter((c) =>
        ["th", "td"].includes(c.nodeName.toLowerCase()),
      )
    : [];
  const columns = headers.map((th, index) =>
    readColumnAttrs({
      id: th.getAttribute("data-column-id") || newDatabaseId(),
      name: (th.textContent ?? "").trim(),
      type: th.getAttribute("data-column-type") || (index === 0 ? "title" : "text"),
      options: readOptions(parseJson(th.getAttribute("data-options"))),
      width: th.getAttribute("data-width"),
    }),
  );
  const rows = bodyRows.map((tr) => {
    const tds = Array.from(tr.children).filter((c) =>
      ["td", "th"].includes(c.nodeName.toLowerCase()),
    );
    const cells: Record<string, CellValue> = {};
    columns.forEach((column, i) => {
      const td = tds[i];
      if (!td) return;
      const stored = parseJson(td.getAttribute("data-value"));
      const value =
        stored !== undefined
          ? readCellValue(column, stored)
          : toCellValue(column, (td.textContent ?? "").trim(), true);
      if (value !== null) cells[column.id] = value;
    });
    return { id: tr.getAttribute("data-row-id") || newDatabaseId(), cells };
  });
  return withUsedOptions({
    id: element.getAttribute("data-id") || newDatabaseId(),
    title: element.getAttribute("data-title") ?? "",
    columns,
    rows,
  });
}
