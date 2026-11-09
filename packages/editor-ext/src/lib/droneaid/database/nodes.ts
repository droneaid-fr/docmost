import { Node } from "@tiptap/core";
import { Fragment } from "@tiptap/pm/model";
import { Plugin, PluginKey, Transaction } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import { ReactNodeViewRenderer } from "@tiptap/react";
import {
  DATABASE_CELL_NODE,
  DATABASE_COLUMN_NODE,
  DATABASE_NODE,
  DATABASE_ROW_NODE,
  DatabaseData,
} from "./types";
import {
  DatabaseSpec,
  createDatabaseData,
  databaseText,
  databaseToJson,
  newDatabaseId,
  readDatabaseNode,
} from "./model";
import { DATABASE_HTML_TYPE, databaseDomSpec, readDatabaseElement } from "./html";
import { reidDatabaseJson } from "./columns";
import { isEmptyView, readView } from "./view";

/**
 * The database block: four node types (see adr-0001). The database node is
 * an atom whose view draws the whole table; ProseMirror itself never renders
 * the child nodes, so a large database costs no editor DOM.
 */

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    droneaidDatabase: {
      insertDatabase: (spec?: DatabaseSpec) => ReturnType;
    };
  }
}

export interface DatabaseOptions {
  /** React component for the node view (client only). */
  view: any;
}

/** Wraps Tiptap's React node view so ProseMirror gets no contentDOM. */
function opaqueReactNodeView(component: any) {
  const factory = ReactNodeViewRenderer(component, {
    stopEvent: () => true,
    ignoreMutation: () => true,
  } as any);
  return (props: any) => {
    const view: any = factory(props);
    Object.defineProperty(view, "contentDOM", { get: () => null });
    view.contentDOMElement?.remove?.();
    return view;
  };
}

/** Builds the block's ProseMirror nodes from typed data. */
export function databaseFragment(schema: any, data: DatabaseData): Fragment {
  return Fragment.from(schema.nodeFromJSON(databaseToJson(data)).content);
}

export const DroneaidDatabase = Node.create<DatabaseOptions>({
  name: DATABASE_NODE,
  group: "block",
  content: `(${DATABASE_COLUMN_NODE} | ${DATABASE_ROW_NODE})*`,
  atom: true,
  isolating: true,
  selectable: true,
  draggable: true,
  defining: true,

  addOptions() {
    return { view: null };
  },

  addAttributes() {
    return {
      id: {
        default: null,
        rendered: false,
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-id") || newDatabaseId(),
      },
      title: {
        default: "",
        rendered: false,
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-title") ?? "",
      },
      /** Shared sort and filter state (view.ts); null when there is none. */
      view: {
        default: null,
        rendered: false,
        parseHTML: (element: HTMLElement) => {
          const view = readView(element.getAttribute("data-view"));
          return isEmptyView(view) ? null : view;
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: `div[data-type="${DATABASE_HTML_TYPE}"]`,
        getContent: (element: HTMLElement, schema: any) =>
          databaseFragment(schema, readDatabaseElement(element)),
      } as any,
    ];
  },

  renderHTML({ node }) {
    return databaseDomSpec(readDatabaseNode(node));
  },

  renderText({ node }) {
    return databaseText(readDatabaseNode(node));
  },

  addNodeView() {
    if (!this.options.view) return null;
    return opaqueReactNodeView(this.options.view);
  },

  addProseMirrorPlugins() {
    return [databaseIdPlugin()];
  },

  addCommands() {
    return {
      insertDatabase:
        (spec) =>
        ({ commands }) =>
          commands.insertContent(databaseToJson(createDatabaseData(spec))),
    };
  },
});

/** Meta key y-prosemirror sets on transactions that apply remote changes. */
const Y_SYNC_META = "y-sync$";

function isRemote(tr: Transaction): boolean {
  return Boolean((tr.getMeta(Y_SYNC_META) as any)?.isChangeOrigin);
}

/** Whether a transaction inserts content that holds a database (cheap). */
function insertsDatabase(tr: Transaction): boolean {
  return tr.steps.some((step: any) => {
    const content: Fragment | undefined = step.slice?.content;
    if (!content?.size) return false;
    let found = false;
    content.descendants((node) => {
      if (found) return false;
      if (node.type.name === DATABASE_NODE) found = true;
      return !found && node.type.name !== DATABASE_ROW_NODE;
    });
    return found;
  });
}

/**
 * Gives a pasted or duplicated database fresh ids. After a local change,
 * if two databases in the document share an id (or one has none), every
 * one that did not exist before the change gets new database, column and
 * row ids. Remote changes are left alone: the client that made them fixes
 * its own copies, and re-iding on every client would diverge.
 */
export function databaseIdPlugin() {
  return new Plugin({
    key: new PluginKey("droneaidDatabaseIds"),
    appendTransaction(transactions, oldState, newState) {
      const local = transactions.filter((tr) => tr.docChanged && !isRemote(tr));
      if (!local.some(insertsDatabase)) return null;

      const found: { pos: number; node: any }[] = [];
      newState.doc.descendants((node, pos) => {
        if (node.type.name !== DATABASE_NODE) return true;
        found.push({ pos, node });
        return false;
      });
      const counts = new Map<string, number>();
      for (const { node } of found) {
        const id = node.attrs.id ?? "";
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      const clashing = found.filter(
        ({ node }) => !node.attrs.id || (counts.get(node.attrs.id) ?? 0) > 1,
      );
      if (!clashing.length) return null;

      // Where each database of the old document ended up.
      const mapping = new Mapping(transactions.flatMap((tr) => tr.mapping.maps));
      const originals = new Set<number>();
      oldState.doc.descendants((node, pos) => {
        if (node.type.name !== DATABASE_NODE) return true;
        const result = mapping.mapResult(pos, 1);
        if (!result.deleted) originals.add(result.pos);
        return false;
      });

      const keep = new Set<number>();
      const kept = new Set<string>();
      // An original keeps its id; otherwise the first copy does.
      for (const { pos, node } of clashing) {
        if (node.attrs.id && originals.has(pos) && !kept.has(node.attrs.id)) {
          keep.add(pos);
          kept.add(node.attrs.id);
        }
      }
      for (const { pos, node } of clashing) {
        if (node.attrs.id && !kept.has(node.attrs.id)) {
          keep.add(pos);
          kept.add(node.attrs.id);
        }
      }

      const tr = newState.tr;
      for (const { pos, node } of [...clashing].reverse()) {
        if (keep.has(pos)) continue;
        const fresh = newState.schema.nodeFromJSON(reidDatabaseJson(node.toJSON()));
        tr.replaceWith(pos, pos + node.nodeSize, fresh);
      }
      return tr.docChanged ? tr : null;
    },
  });
}

export const DroneaidDatabaseColumn = Node.create({
  name: DATABASE_COLUMN_NODE,
  atom: true,
  selectable: false,
  addAttributes() {
    return {
      id: { default: null },
      name: { default: "" },
      type: { default: "text" },
      options: { default: [] },
      width: { default: null },
    };
  },
  renderHTML() {
    return ["span", { "data-type": "droneaid-database-column" }];
  },
});

export const DroneaidDatabaseRow = Node.create({
  name: DATABASE_ROW_NODE,
  content: `${DATABASE_CELL_NODE}*`,
  selectable: false,
  addAttributes() {
    return { id: { default: null } };
  },
  renderHTML() {
    return ["span", { "data-type": "droneaid-database-row" }, 0];
  },
});

export const DroneaidDatabaseCell = Node.create({
  name: DATABASE_CELL_NODE,
  atom: true,
  selectable: false,
  addAttributes() {
    return {
      column: { default: null },
      value: { default: null },
    };
  },
  renderHTML() {
    return ["span", { "data-type": "droneaid-database-cell" }];
  },
});

/** All four nodes, for an extensions list. */
export const DroneaidDatabaseExtensions = [
  DroneaidDatabase,
  DroneaidDatabaseColumn,
  DroneaidDatabaseRow,
  DroneaidDatabaseCell,
];
