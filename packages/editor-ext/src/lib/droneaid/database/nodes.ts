import { Node } from "@tiptap/core";
import { Fragment } from "@tiptap/pm/model";
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

  addCommands() {
    return {
      insertDatabase:
        (spec) =>
        ({ commands }) =>
          commands.insertContent(databaseToJson(createDatabaseData(spec))),
    };
  },
});

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
