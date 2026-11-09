import { describe, expect, it } from "vitest";
import {
  DatabaseColumn,
  DatabaseRow,
  DatabaseViewState,
  FilterRule,
  applyView,
  databaseToHtml,
  databaseToMarkdown,
  parseDatabaseMarkdown,
  readDatabaseJson,
  readView,
  databaseToJson,
  viewWithRenamedLabel,
  viewWithoutColumn,
} from "@docmost/editor-ext";
import { displayRows } from "./use-view-state";

const col = (id: string, type: DatabaseColumn["type"], options: string[] = []): DatabaseColumn => ({
  id,
  name: id,
  type,
  options: options.map((label) => ({ label, color: "gray" })),
  width: null,
});

const columns = [
  col("name", "title"),
  col("n", "number"),
  col("s", "select", ["Open", "Done", "Lost"]),
  col("m", "multi-select", ["a", "b", "c"]),
  col("d", "date"),
  col("c", "checkbox"),
];

const rows: DatabaseRow[] = [
  { id: "r1", cells: { name: "Alpha", n: 3, s: "Done", m: ["a"], d: "2026-01-10", c: true } },
  { id: "r2", cells: { name: "beta", n: 10, s: "Open", m: ["b", "c"], d: "2026-03-01" } },
  { id: "r3", cells: { name: "Gamma", s: "Open" } },
  { id: "r4", cells: { name: "delta", n: -1, s: "Lost", m: ["a", "c"], d: "2025-12-31", c: true } },
  { id: "r5", cells: {} },
];

const ids = (list: DatabaseRow[]) => list.map((r) => r.id);
const filter = (column: string, op: FilterRule["op"], value: FilterRule["value"] = null): DatabaseViewState => ({
  sorts: [],
  filters: [{ id: "f", column, op, value }],
});

describe("database view: filters", () => {
  it("text contains / does not contain / is empty (case-insensitive)", () => {
    expect(ids(applyView(columns, rows, filter("name", "contains", "ta")))).toEqual(["r2", "r4"]);
    expect(ids(applyView(columns, rows, filter("name", "not-contains", "ALP")))).toEqual(["r2", "r3", "r4", "r5"]);
    expect(ids(applyView(columns, rows, filter("name", "is", "gamma")))).toEqual(["r3"]);
    expect(ids(applyView(columns, rows, filter("name", "is-empty")))).toEqual(["r5"]);
    expect(ids(applyView(columns, rows, filter("name", "is-not-empty")))).toHaveLength(4);
  });

  it("number comparisons; empty cells never match a comparison", () => {
    expect(ids(applyView(columns, rows, filter("n", "gt", 2)))).toEqual(["r1", "r2"]);
    expect(ids(applyView(columns, rows, filter("n", "lte", "3")))).toEqual(["r1", "r4"]);
    expect(ids(applyView(columns, rows, filter("n", "eq", 10)))).toEqual(["r2"]);
    expect(ids(applyView(columns, rows, filter("n", "is-empty")))).toEqual(["r3", "r5"]);
  });

  it("select is / is any of / is none of", () => {
    expect(ids(applyView(columns, rows, filter("s", "is", "Open")))).toEqual(["r2", "r3"]);
    expect(ids(applyView(columns, rows, filter("s", "is-any-of", ["Done", "Lost"])))).toEqual(["r1", "r4"]);
    expect(ids(applyView(columns, rows, filter("s", "is-none-of", ["Open"])))).toEqual(["r1", "r4", "r5"]);
    expect(ids(applyView(columns, rows, filter("m", "is-any-of", ["c"])))).toEqual(["r2", "r4"]);
  });

  it("date before / after / on", () => {
    expect(ids(applyView(columns, rows, filter("d", "before", "2026-01-10")))).toEqual(["r4"]);
    expect(ids(applyView(columns, rows, filter("d", "after", "2026-01-10")))).toEqual(["r2"]);
    expect(ids(applyView(columns, rows, filter("d", "on", "2026-01-10")))).toEqual(["r1"]);
  });

  it("checkbox is checked / unchecked", () => {
    expect(ids(applyView(columns, rows, filter("c", "is", true)))).toEqual(["r1", "r4"]);
    expect(ids(applyView(columns, rows, filter("c", "is", false)))).toEqual(["r2", "r3", "r5"]);
  });

  it("ignores incomplete rules, unknown columns and ops the type does not have", () => {
    expect(applyView(columns, rows, filter("name", "contains", ""))).toBe(rows);
    expect(applyView(columns, rows, filter("gone", "contains", "x"))).toBe(rows);
    expect(applyView(columns, rows, filter("n", "contains", "1"))).toBe(rows);
  });

  it("combines filters with AND", () => {
    const view: DatabaseViewState = {
      sorts: [],
      filters: [
        { id: "1", column: "s", op: "is", value: "Open" },
        { id: "2", column: "n", op: "is-not-empty", value: null },
      ],
    };
    expect(ids(applyView(columns, rows, view))).toEqual(["r2"]);
  });
});

describe("database view: sorts", () => {
  it("sorts numbers both ways with empty values last", () => {
    const asc = { sorts: [{ column: "n", direction: "asc" as const }], filters: [] };
    const desc = { sorts: [{ column: "n", direction: "desc" as const }], filters: [] };
    expect(ids(applyView(columns, rows, asc))).toEqual(["r4", "r1", "r2", "r3", "r5"]);
    expect(ids(applyView(columns, rows, desc))).toEqual(["r2", "r1", "r4", "r3", "r5"]);
  });

  it("sorts text case-insensitively and select by option order", () => {
    const byName = { sorts: [{ column: "name", direction: "asc" as const }], filters: [] };
    expect(ids(applyView(columns, rows, byName))).toEqual(["r1", "r2", "r4", "r3", "r5"]);
    const bySelect = { sorts: [{ column: "s", direction: "asc" as const }], filters: [] };
    expect(ids(applyView(columns, rows, bySelect))).toEqual(["r2", "r3", "r1", "r4", "r5"]);
  });

  it("uses later keys to break ties and keeps document order otherwise", () => {
    const view: DatabaseViewState = {
      sorts: [
        { column: "s", direction: "asc" },
        { column: "name", direction: "desc" },
      ],
      filters: [],
    };
    expect(ids(applyView(columns, rows, view))).toEqual(["r3", "r2", "r1", "r4", "r5"]);
    const checkbox = { sorts: [{ column: "c", direction: "desc" as const }], filters: [] };
    expect(ids(applyView(columns, rows, checkbox))).toEqual(["r1", "r4", "r2", "r3", "r5"]);
  });
});

describe("database view: stored state", () => {
  it("cleans what it reads", () => {
    expect(readView(null)).toEqual({ sorts: [], filters: [] });
    expect(readView("not json")).toEqual({ sorts: [], filters: [] });
    const view = readView({
      sorts: [{ column: "a", direction: "desc" }, { column: "a" }, { nope: 1 }, { column: "b", direction: "x" }],
      filters: [
        { id: "x", column: "a", op: "contains", value: "q" },
        { id: "x", column: "b", op: "bogus" },
        { column: "c", op: "is-any-of", value: ["l", 3] },
      ],
    });
    expect(view.sorts).toEqual([
      { column: "a", direction: "desc" },
      { column: "b", direction: "asc" },
    ]);
    expect(view.filters).toEqual([
      { id: "x", column: "a", op: "contains", value: "q" },
      { id: "f2", column: "c", op: "is-any-of", value: ["l"] },
    ]);
  });

  it("drops rules of a deleted column and follows a renamed label", () => {
    const view: DatabaseViewState = {
      sorts: [{ column: "s", direction: "asc" }],
      filters: [
        { id: "1", column: "s", op: "is-any-of", value: ["Open", "Done"] },
        { id: "2", column: "s", op: "is", value: "Open" },
      ],
    };
    expect(viewWithoutColumn(view, "s")).toEqual({ sorts: [], filters: [] });
    const renamed = viewWithRenamedLabel(view, "s", "Open", "Active");
    expect(renamed.filters.map((f) => f.value)).toEqual([["Active", "Done"], "Active"]);
    expect(viewWithRenamedLabel(view, "s", "Nope", "x")).toBe(view);
  });

  it("round-trips through JSON, HTML and Markdown", () => {
    const view: DatabaseViewState = {
      sorts: [{ column: "n", direction: "desc" }],
      filters: [{ id: "f1", column: "s", op: "is", value: "Open" }],
    };
    const data = { id: "db1", title: "T", columns, rows, view };
    expect(readDatabaseJson(databaseToJson(data)).view).toEqual(view);
    const host = document.createElement("div");
    host.innerHTML = databaseToHtml(data);
    expect(host.firstElementChild!.getAttribute("data-view")).toBe(JSON.stringify(view));
    expect(parseDatabaseMarkdown(databaseToMarkdown(data))!.data.view).toEqual(view);
    const plain = { id: "db2", title: "T", columns, rows };
    expect(readDatabaseJson(databaseToJson(plain)).view).toBeUndefined();
  });
});

describe("pinned new rows", () => {
  it("shows a pinned row below its anchor even when the filter excludes it", () => {
    const view = filter("s", "is", "Open");
    const withNew = [...rows, { id: "new", cells: {} }];
    expect(ids(displayRows(columns, withNew, view, []))).toEqual(["r2", "r3"]);
    expect(ids(displayRows(columns, withNew, view, [{ rowId: "new", after: "r2" }]))).toEqual(["r2", "new", "r3"]);
    expect(ids(displayRows(columns, withNew, view, [{ rowId: "new", after: null }]))).toEqual(["r2", "r3", "new"]);
    expect(ids(displayRows(columns, rows, view, [{ rowId: "gone", after: null }]))).toEqual(["r2", "r3"]);
  });
});
