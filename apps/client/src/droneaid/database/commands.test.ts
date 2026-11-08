import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import {
  DroneaidDatabaseExtensions,
  readDatabaseNode,
} from "@docmost/editor-ext";
import { addRow, removeRow, setCellValue, setDatabaseTitle } from "./commands";

let editor: Editor;

function setup() {
  editor = new Editor({
    extensions: [StarterKit, ...DroneaidDatabaseExtensions],
    content: "<p>x</p>",
  });
  editor.commands.insertDatabase({
    columns: [
      { name: "Status", type: "select" },
      { name: "Count", type: "number" },
    ],
    rows: [{ Name: "a" }, { Name: "b" }],
  });
  let pos = -1;
  editor.state.doc.descendants((node, p) => {
    if (node.type.name === "droneaidDatabase") pos = p;
    return pos < 0;
  });
  const getPos = () => pos;
  const read = () => readDatabaseNode(editor.state.doc.nodeAt(pos));
  return { getPos, read };
}

afterEach(() => editor?.destroy());

describe("database commands", () => {
  it("sets a missing cell, updates it and clears it", () => {
    const { getPos, read } = setup();
    const data = read();
    const count = data.columns[2];
    setCellValue(editor, getPos, data.rows[1].id, count, 5);
    expect(read().rows[1].cells[count.id]).toBe(5);
    setCellValue(editor, getPos, data.rows[1].id, count, 6);
    expect(read().rows[1].cells[count.id]).toBe(6);
    setCellValue(editor, getPos, data.rows[1].id, count, null);
    expect(read().rows[1].cells[count.id]).toBeUndefined();
    expect(read().rows[0].cells[data.columns[0].id]).toBe("a");
  });

  it("adds new select labels to the column options in the same transaction", () => {
    const { getPos, read } = setup();
    const data = read();
    let transactions = 0;
    editor.on("transaction", () => transactions++);
    setCellValue(editor, getPos, data.rows[0].id, data.columns[1], "Open");
    expect(transactions).toBe(1);
    expect(read().columns[1].options.map((o) => o.label)).toEqual(["Open"]);
    expect(read().rows[0].cells[data.columns[1].id]).toBe("Open");
  });

  it("adds and removes rows, and sets the title", () => {
    const { getPos, read } = setup();
    const id = addRow(editor, getPos);
    expect(read().rows.map((r) => r.id).at(-1)).toBe(id);
    const first = read().rows[0].id;
    const second = addRow(editor, getPos, first);
    expect(read().rows[1].id).toBe(second);
    removeRow(editor, getPos, first);
    expect(read().rows.map((r) => r.id)).not.toContain(first);
    expect(read().rows).toHaveLength(3);
    setDatabaseTitle(editor, getPos, "Guests");
    expect(read().title).toBe("Guests");
  });
});
