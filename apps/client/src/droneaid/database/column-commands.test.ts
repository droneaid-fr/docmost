import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import {
  DroneaidDatabaseExtensions,
  planRetype,
  readDatabaseNode,
  relabelValue,
} from "@docmost/editor-ext";
import {
  addColumn,
  changeOptions,
  countOptionUse,
  moveColumn,
  previewRetype,
  removeColumn,
  renameColumn,
  retypeColumn,
  setColumnWidth,
} from "./column-commands";
import { moveRow, removeRows, setDatabaseView } from "./commands";

let editor: Editor;

function setup() {
  editor = new Editor({
    extensions: [StarterKit, ...DroneaidDatabaseExtensions],
    content: "<p>x</p>",
  });
  editor.commands.insertDatabase({
    columns: [
      { name: "Status", type: "select", options: ["Open", "Done"] },
      { name: "Tags", type: "multi-select", options: ["a", "b"] },
      { name: "Count", type: "text" },
    ],
    rows: [
      { Name: "one", Status: "Open", Tags: ["a", "b"], Count: "12" },
      { Name: "two", Status: "Done", Tags: ["b"], Count: "x" },
      { Name: "three", Count: "1,5" },
    ],
  });
  let pos = -1;
  editor.state.doc.descendants((node, p) => {
    if (node.type.name === "droneaidDatabase") pos = p;
    return pos < 0;
  });
  const getPos = () => pos;
  const read = () => readDatabaseNode(editor.state.doc.nodeAt(pos));
  const col = (name: string) => read().columns.find((c) => c.name === name)!;
  const values = (name: string) => read().rows.map((r) => r.cells[col(name).id] ?? null);
  return { getPos, read, col, values };
}

afterEach(() => editor?.destroy());

describe("column commands", () => {
  it("adds a column next to another one, renames and resizes it", () => {
    const { getPos, read, col } = setup();
    const id = addColumn(editor, getPos, { name: "Notes", type: "text" }, { columnId: col("Status").id, side: "left" });
    expect(read().columns.map((c) => c.name)).toEqual(["Name", "Notes", "Status", "Tags", "Count"]);
    renameColumn(editor, getPos, id!, "  Remarks ");
    expect(read().columns[1].name).toBe("Remarks");
    setColumnWidth(editor, getPos, id!, 5000);
    expect(read().columns[1].width).toBe(800);
    addColumn(editor, getPos, { name: "Last", type: "date" });
    expect(read().columns.at(-1)!.name).toBe("Last");
  });

  it("moves a column and keeps every value", () => {
    const { getPos, read, col, values } = setup();
    const before = values("Count");
    moveColumn(editor, getPos, col("Count").id, col("Name").id, "before");
    expect(read().columns.map((c) => c.name)).toEqual(["Count", "Name", "Status", "Tags"]);
    expect(values("Count")).toEqual(before);
    moveColumn(editor, getPos, col("Count").id, col("Tags").id, "after");
    expect(read().columns.map((c) => c.name)).toEqual(["Name", "Status", "Tags", "Count"]);
  });

  it("removes a column, its cells and its view rules; refuses the title column", () => {
    const { getPos, read, col } = setup();
    const status = col("Status").id;
    setDatabaseView(editor, getPos, {
      sorts: [{ column: status, direction: "asc" }],
      filters: [{ id: "f", column: col("Count").id, op: "contains", value: "1" }],
    });
    removeColumn(editor, getPos, status);
    const data = read();
    expect(data.columns.map((c) => c.name)).toEqual(["Name", "Tags", "Count"]);
    let cells = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "droneaidDatabaseCell" && node.attrs.column === status) cells++;
    });
    expect(cells).toBe(0);
    expect(data.view?.sorts).toEqual([]);
    expect(data.view?.filters).toHaveLength(1);
    expect(() => removeColumn(editor, getPos, col("Name").id)).toThrow(/title/);
  });

  it("previews a lossy retype and converts values", () => {
    const { getPos, col, values } = setup();
    const plan = previewRetype(editor, getPos, col("Count").id, "number")!;
    expect(plan.values).toEqual([12, null, 1.5]);
    expect(plan).toMatchObject({ changed: 2, cleared: 1 });
    retypeColumn(editor, getPos, col("Count").id, "number");
    expect(col("Count").type).toBe("number");
    expect(values("Count")).toEqual([12, null, 1.5]);
  });

  it("retypes multi-select to select keeping the first label, and select to text", () => {
    const { getPos, col, values } = setup();
    retypeColumn(editor, getPos, col("Tags").id, "select");
    expect(values("Tags")).toEqual(["a", "b", null]);
    retypeColumn(editor, getPos, col("Status").id, "text");
    expect(col("Status").options).toEqual([]);
    expect(values("Status")).toEqual(["Open", "Done", null]);
    retypeColumn(editor, getPos, col("Status").id, "multi-select");
    expect(col("Status").options.map((o) => o.label)).toEqual(["Open", "Done"]);
    expect(values("Status")).toEqual([["Open"], ["Done"], null]);
  });

  it("renames an option: cells and filters follow", () => {
    const { getPos, read, col, values } = setup();
    const tags = col("Tags");
    setDatabaseView(editor, getPos, {
      sorts: [],
      filters: [{ id: "f", column: tags.id, op: "is-any-of", value: ["b"] }],
    });
    changeOptions(editor, getPos, tags.id, {
      options: tags.options.map((o) => (o.label === "b" ? { ...o, label: "beta" } : o)),
      renames: { b: "beta" },
    });
    expect(col("Tags").options.map((o) => o.label)).toEqual(["a", "beta"]);
    expect(values("Tags")).toEqual([["a", "beta"], ["beta"], null]);
    expect(read().view?.filters[0].value).toEqual(["beta"]);
  });

  it("deletes an option and clears it from cells; recolours", () => {
    const { getPos, col, values } = setup();
    const status = col("Status");
    expect(countOptionUse(editor, getPos, status.id, "Open")).toBe(1);
    changeOptions(editor, getPos, status.id, {
      options: status.options.filter((o) => o.label !== "Open"),
      removed: ["Open"],
    });
    expect(values("Status")).toEqual([null, "Done", null]);
    changeOptions(editor, getPos, status.id, { options: [{ label: "Done", color: "red" }] });
    expect(col("Status").options).toEqual([{ label: "Done", color: "red" }]);
  });

  it("removes several rows and moves a row", () => {
    const { getPos, read } = setup();
    const [a, b, c] = read().rows.map((r) => r.id);
    moveRow(editor, getPos, c, a, "before");
    expect(read().rows.map((r) => r.id)).toEqual([c, a, b]);
    moveRow(editor, getPos, c, b, "after");
    expect(read().rows.map((r) => r.id)).toEqual([a, b, c]);
    expect(read().rows[2].cells).toEqual({ [read().columns[0].id]: "three", [read().columns[3].id]: "1,5" });
    removeRows(editor, getPos, [a, c]);
    expect(read().rows.map((r) => r.id)).toEqual([b]);
  });
});

describe("column planning helpers", () => {
  const select = { id: "s", name: "S", type: "select" as const, options: [], width: null };
  it("relabels values", () => {
    expect(relabelValue(select, "a", { a: "b" })).toBe("b");
    expect(relabelValue(select, "a", {}, new Set(["a"]))).toBeNull();
    const multi = { ...select, type: "multi-select" as const };
    expect(relabelValue(multi, ["a", "b"], { a: "b" })).toEqual(["b"]);
    const same = ["x"];
    expect(relabelValue(multi, same, { a: "b" })).toBe(same);
  });

  it("refuses to retype the title column", () => {
    expect(() => planRetype({ ...select, type: "title" }, "text", [])).toThrow();
    expect(() => planRetype(select, "title", [])).toThrow();
  });
});
