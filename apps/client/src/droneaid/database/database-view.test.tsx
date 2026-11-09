import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { readDatabaseNode } from "@docmost/editor-ext";
import { databaseExtensions } from "./index";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      key.replace(/\{\{(\w+)\}\}/g, (match, name) =>
        options && name in options ? String(options[name]) : match,
      ) + (options && "count" in options ? `:${options.count}` : ""),
  }),
}));

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  document.elementFromPoint = () => null;
  Element.prototype.scrollIntoView = () => {};
  // The row virtualiser measures its scroll box; jsdom has no layout.
  for (const [prop, size] of [["offsetHeight", 500], ["offsetWidth", 900]] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => size });
  }
  globalThis.CSS ??= {} as typeof CSS;
  CSS.escape ??= (value: string) => value;
});

afterEach(() => cleanup());

const content = {
  type: "doc",
  content: [
    {
      type: "droneaidDatabase",
      attrs: { id: "db", title: "Targets" },
      content: [
        { type: "droneaidDatabaseColumn", attrs: { id: "name", name: "Name", type: "title" } },
        {
          type: "droneaidDatabaseColumn",
          attrs: {
            id: "status",
            name: "Status",
            type: "select",
            options: [
              { label: "Open", color: "blue" },
              { label: "Done", color: "green" },
            ],
          },
        },
        { type: "droneaidDatabaseColumn", attrs: { id: "n", name: "Staff", type: "number" } },
        ...[
          ["r1", "Charlie", "Open", 3],
          ["r2", "Alpha", "Done", 10],
          ["r3", "Bravo", "Open", 1],
        ].map(([id, name, status, n]) => ({
          type: "droneaidDatabaseRow",
          attrs: { id },
          content: [
            { type: "droneaidDatabaseCell", attrs: { column: "name", value: name } },
            { type: "droneaidDatabaseCell", attrs: { column: "status", value: status } },
            { type: "droneaidDatabaseCell", attrs: { column: "n", value: n } },
          ],
        })),
      ],
    },
    { type: "paragraph" },
  ],
};

function Harness({ editable, onEditor }: { editable: boolean; onEditor: (e: Editor) => void }) {
  const editor = useEditor({
    extensions: [StarterKit, ...databaseExtensions],
    content,
    editable,
    immediatelyRender: true,
  });
  useEffect(() => {
    if (editor) onEditor(editor);
  }, [editor, onEditor]);
  return <EditorContent editor={editor} />;
}

async function mount(editable = true) {
  let editor!: Editor;
  render(
    <MantineProvider env="test">
      <ModalsProvider>
        <Harness editable={editable} onEditor={(e) => (editor = e)} />
      </ModalsProvider>
    </MantineProvider>,
  );
  await settle();
  return { editor, data: () => readDatabaseNode(editor.state.doc.firstChild) };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const names = () =>
  Array.from(document.querySelectorAll('[role="row"][data-row-id]'))
    .sort(
      (a, b) =>
        Number(/-?\d+/.exec((a as HTMLElement).style.transform)?.[0] ?? 0) -
        Number(/-?\d+/.exec((b as HTMLElement).style.transform)?.[0] ?? 0),
    )
    .map((row) => row.querySelector('[data-column-id="name"]')!.textContent);

const grid = () => screen.getByRole("grid");
const cell = (rowId: string, columnId: string) =>
  document.querySelector(`[data-row-id="${rowId}"] [data-column-id="${columnId}"]`)!;

async function act_(fn: () => void) {
  await act(async () => fn());
  await settle();
}

async function openHeaderMenu(name: string) {
  await act_(() => fireEvent.click(screen.getByLabelText(`${name} — database.column.menu`)));
}

describe("DatabaseView", () => {
  it("renders rows in stored order with a row count", async () => {
    await mount();
    expect(names()).toEqual(["Charlie", "Alpha", "Bravo"]);
    expect(screen.getByTestId("database-row-count").textContent).toBe("database.rows:3");
  });

  it("sorts from the column menu, stores the view on the node and shows a chip", async () => {
    const { data } = await mount();
    await openHeaderMenu("Staff");
    await act_(() => fireEvent.click(screen.getByText("database.column.sortDesc")));
    expect(names()).toEqual(["Alpha", "Charlie", "Bravo"]);
    expect(data().view?.sorts).toEqual([{ column: "n", direction: "desc" }]);
    const chip = screen.getByRole("listitem");
    expect(chip.textContent).toContain("Staff");
    await act_(() => fireEvent.click(within(chip).getByLabelText("database.removeRule")));
    expect(names()).toEqual(["Charlie", "Alpha", "Bravo"]);
    expect(data().view).toBeUndefined();
  });

  it("keeps a row added under an active filter visible", async () => {
    const { editor, data } = await mount();
    act(() => {
      editor.commands.command(({ tr }) => {
        tr.setNodeAttribute(0, "view", {
          sorts: [],
          filters: [{ id: "f", column: "status", op: "is", value: "Open" }],
        });
        return true;
      });
    });
    await settle();
    expect(names()).toEqual(["Charlie", "Bravo"]);
    expect(screen.getByTestId("database-row-count").textContent).toBe("database.rowsFiltered");
    await act_(() => fireEvent.click(screen.getByText("database.newRow")));
    expect(data().rows).toHaveLength(4);
    expect(names()).toEqual(["Charlie", "Bravo", ""]);
    expect(screen.getByText("database.pinnedHint:1")).toBeTruthy();
  });

  it("navigates with the keyboard, edits by typing and copies a value", async () => {
    const { data } = await mount();
    await act_(() => fireEvent.mouseDown(cell("r1", "name")));
    expect(cell("r1", "name").getAttribute("data-active")).toBe("true");
    await act_(() => fireEvent.keyDown(grid(), { key: "ArrowDown" }));
    await act_(() => fireEvent.keyDown(grid(), { key: "ArrowRight" }));
    await act_(() => fireEvent.keyDown(grid(), { key: "Tab" }));
    expect(cell("r2", "n").getAttribute("data-active")).toBe("true");
    await act_(() => fireEvent.keyDown(grid(), { key: "4" }));
    const input = cell("r2", "n").querySelector("input")!;
    expect(input.value).toBe("4");
    await act_(() => fireEvent.change(input, { target: { value: "42" } }));
    await act_(() => fireEvent.keyDown(input, { key: "Enter" }));
    expect(data().rows[1].cells.n).toBe(42);
    expect(cell("r2", "n").querySelector("input")).toBeNull();

    const clipboard = new Map<string, string>();
    const copy = new Event("copy", { bubbles: true }) as ClipboardEvent;
    Object.defineProperty(copy, "clipboardData", {
      value: { setData: (k: string, v: string) => clipboard.set(k, v) },
    });
    await act_(() => grid().dispatchEvent(copy));
    expect(clipboard.get("text/plain")).toBe("42");

    await act_(() => fireEvent.keyDown(grid(), { key: "ArrowUp" }));
    const paste = new Event("paste", { bubbles: true }) as ClipboardEvent;
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => "7\n" } });
    await act_(() => grid().dispatchEvent(paste));
    expect(data().rows[0].cells.n).toBe(7);

    await act_(() => fireEvent.keyDown(grid(), { key: "Delete" }));
    expect(data().rows[0].cells.n).toBeUndefined();
  });

  it("edits a select cell: type to filter, Enter creates a new option", async () => {
    const { data } = await mount();
    await act_(() => fireEvent.mouseDown(cell("r1", "status")));
    await act_(() => fireEvent.keyDown(grid(), { key: "Enter" }));
    const search = screen.getByPlaceholderText("database.select.search");
    await act_(() => fireEvent.change(search, { target: { value: "do" } }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Done", 'database.select.create']);
    await act_(() => fireEvent.change(search, { target: { value: "Blocked" } }));
    await act_(() => fireEvent.keyDown(search, { key: "Enter" }));
    expect(data().rows[0].cells.status).toBe("Blocked");
    expect(data().columns[1].options.map((o) => o.label)).toEqual(["Open", "Done", "Blocked"]);
  });

  it("renames a select option from the options editor; cells follow", async () => {
    const { data } = await mount();
    await openHeaderMenu("Status");
    await act_(() => fireEvent.click(screen.getByText("database.column.editOptions")));
    const field = screen.getByLabelText("Open") as HTMLInputElement;
    await act_(() => fireEvent.change(field, { target: { value: "Active" } }));
    await act_(() => fireEvent.keyDown(field, { key: "Enter" }));
    expect(data().columns[1].options.map((o) => o.label)).toEqual(["Active", "Done"]);
    expect(data().rows.map((r) => r.cells.status)).toEqual(["Active", "Done", "Active"]);
  });

  it("is read-only for readers, with a local sort that is not stored", async () => {
    const { data } = await mount(false);
    expect(screen.queryByText("database.newRow")).toBeNull();
    await openHeaderMenu("Name");
    expect(screen.queryByText("database.column.delete")).toBeNull();
    await act_(() => fireEvent.click(screen.getByText("database.column.sortAsc")));
    expect(names()).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(data().view).toBeUndefined();
    expect(screen.getByText("database.localView")).toBeTruthy();
    await act_(() => fireEvent.mouseDown(cell("r1", "name")));
    await act_(() => fireEvent.keyDown(grid(), { key: "x" }));
    expect(cell("r1", "name").querySelector("input")).toBeNull();
  });
});
