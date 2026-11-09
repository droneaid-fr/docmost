import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import {
  DroneaidDatabaseExtensions,
  findDatabasesInJson,
  reidDatabaseJson,
} from "@docmost/editor-ext";

let editor: Editor;

function setup() {
  editor = new Editor({
    extensions: [StarterKit, ...DroneaidDatabaseExtensions],
    content: "<p>before</p><p>after</p>",
  });
  editor.commands.setTextSelection(1);
  editor.commands.insertDatabase({
    title: "Guests",
    columns: [{ name: "Status", type: "select", options: ["In", "Out"] }],
    rows: [{ Name: "Ann", Status: "In" }, { Name: "Bob", Status: "Out" }],
  });
  const db = () => findDatabasesInJson(editor.getJSON());
  return { db };
}

function databaseNodeJson() {
  return editor.getJSON().content!.find((n) => n.type === "droneaidDatabase")!;
}

afterEach(() => editor?.destroy());

function expectSeparateCopies(list: ReturnType<typeof findDatabasesInJson>) {
  const [original, copy] = list;
  expect(copy.id).not.toBe(original.id);
  const originalIds = new Set([
    ...original.columns.map((c) => c.id),
    ...original.rows.map((r) => r.id),
  ]);
  for (const c of copy.columns) expect(originalIds.has(c.id)).toBe(false);
  for (const r of copy.rows) expect(originalIds.has(r.id)).toBe(false);
  // Same content under the new ids.
  expect(copy.title).toBe(original.title);
  expect(copy.columns.map((c) => [c.name, c.type, c.options])).toEqual(
    original.columns.map((c) => [c.name, c.type, c.options]),
  );
  const values = (d: typeof original) =>
    d.rows.map((r) => d.columns.map((c) => r.cells[c.id] ?? null));
  expect(values(copy)).toEqual(values(original));
}

describe("database id refresh", () => {
  it("re-ids a pasted copy (HTML clipboard path) and keeps the original", () => {
    const { db } = setup();
    const original = db()[0];
    const html = editor.getHTML();
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    const fragment = html.slice(html.indexOf("<div"), html.lastIndexOf("</div>") + 6);
    // jsdom has no ClipboardEvent; any event object will do for the paste path.
    editor.view.pasteHTML(fragment, new Event("paste") as ClipboardEvent);
    const list = db();
    expect(list).toHaveLength(2);
    expect(list.find((d) => d.id === original.id)).toBeTruthy();
    expectSeparateCopies(list[0].id === original.id ? list : [list[1], list[0]]);
  });

  it("re-ids a duplicate inserted as JSON, even above the original", () => {
    const { db } = setup();
    const original = db()[0];
    editor.commands.insertContentAt(0, databaseNodeJson());
    const list = db();
    expect(list).toHaveLength(2);
    expect(list[1].id).toBe(original.id);
    expectSeparateCopies([list[1], list[0]]);
  });

  it("leaves remote (collaboration) changes alone", () => {
    const { db } = setup();
    const node = editor.schema.nodeFromJSON(databaseNodeJson());
    const tr = editor.state.tr.insert(0, node).setMeta("y-sync$", { isChangeOrigin: true });
    editor.view.dispatch(tr);
    const list = db();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(list[1].id);
  });

  it("does nothing for ordinary edits", () => {
    const { db } = setup();
    const before = JSON.stringify(db());
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, "more text");
    expect(JSON.stringify(db())).toBe(before);
  });

  it("reidDatabaseJson remaps cells and view rules to the new column ids", () => {
    const json = {
      type: "droneaidDatabase",
      attrs: {
        id: "db",
        title: "T",
        view: { sorts: [{ column: "c1", direction: "asc" }], filters: [{ id: "f", column: "c1", op: "is-empty", value: null }] },
      },
      content: [
        { type: "droneaidDatabaseColumn", attrs: { id: "c1", name: "N", type: "title" } },
        { type: "droneaidDatabaseRow", attrs: { id: "r1" }, content: [{ type: "droneaidDatabaseCell", attrs: { column: "c1", value: "x" } }] },
      ],
    };
    const copy = reidDatabaseJson(json);
    const newCol = copy.content[0].attrs.id;
    expect(copy.attrs.id).not.toBe("db");
    expect(newCol).not.toBe("c1");
    expect(copy.content[1].attrs.id).not.toBe("r1");
    expect(copy.content[1].content[0].attrs).toEqual({ column: newCol, value: "x" });
    expect(copy.attrs.view.sorts[0].column).toBe(newCol);
    expect(copy.attrs.view.filters[0].column).toBe(newCol);
    expect(json.content[0].attrs.id).toBe("c1");
  });
});
