import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import {
  updateYFragment,
  yXmlFragmentToProseMirrorRootNode,
} from '@tiptap/y-tiptap';
import { EditorState } from '@tiptap/pm/state';
import { readDatabaseNode } from '@docmost/editor-ext';
import { tiptapExtensions } from '../../collaboration/collaboration.util';
import { addColumn, addRows, createDatabase, readDatabase, updateRows } from './database-ydoc';
import { targetListSpec } from './database-fixtures';

/** Two replicas that exchange updates only when sync() is called. */
function replicas() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const data = createDatabase(a, targetListSpec(20));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const sync = () => {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
  };
  return { a, b, data, sync };
}

const schema = getSchema(tiptapExtensions);

/**
 * A client edit the way the browser makes it: a ProseMirror transaction on
 * the doc, written back to Yjs by y-prosemirror's diff (updateYFragment).
 */
function pmEdit(doc: Y.Doc, edit: (state: EditorState) => any) {
  const fragment = doc.getXmlFragment('default');
  const meta = { mapping: new Map(), isOMark: new Map() };
  const pmDoc = yXmlFragmentToProseMirrorRootNode(fragment, schema);
  const state = EditorState.create({ doc: pmDoc, schema });
  const tr = edit(state);
  doc.transact(() => updateYFragment(doc, fragment, tr.doc, meta as any));
}

function cellPos(state: EditorState, rowId: string, columnId: string) {
  let found = -1;
  state.doc.descendants((node, pos, parent) => {
    if (
      node.type.name === 'droneaidDatabaseCell' &&
      node.attrs.column === columnId &&
      parent?.attrs.id === rowId
    ) {
      found = pos;
    }
    return found < 0;
  });
  if (found < 0) throw new Error('cell not found');
  return found;
}

describe('database concurrency', () => {
  it('keeps both edits to different rows (server model)', () => {
    const { a, b, data, sync } = replicas();
    const [status, staff] = [data.columns[3].id, data.columns[2].id];
    updateRows(a, data.id, [{ id: data.rows[1].id, values: { Status: 'Partner' } }]);
    updateRows(b, data.id, [{ id: data.rows[5].id, values: { Staff: 999 } }]);
    sync();
    for (const doc of [a, b]) {
      const read = readDatabase(doc);
      expect(read.rows[1].cells[status]).toBe('Partner');
      expect(read.rows[5].cells[staff]).toBe(999);
    }
    expect(readDatabase(a)).toEqual(readDatabase(b));
  });

  it('keeps both edits to different cells of the same row, incl. new cells', () => {
    const { a, b, data, sync } = replicas();
    const row = data.rows[7]; // row 7 has no Staff cell (7 % 7 === 0)
    updateRows(a, data.id, [{ id: row.id, values: { Staff: 12 } }]);
    updateRows(b, data.id, [{ id: row.id, values: { Notes: 'from B', Priority: true } }]);
    sync();
    const read = readDatabase(a);
    const cells = read.rows[7].cells;
    expect(cells[data.columns[2].id]).toBe(12);
    expect(cells[data.columns[1].id]).toBe('from B');
    expect(cells[data.columns[6].id]).toBe(true);
    expect(readDatabase(b)).toEqual(read);
  });

  it('keeps concurrent row and column additions', () => {
    const { a, b, data, sync } = replicas();
    const [rowA] = addRows(a, data.id, [{ Organisation: 'A' }]);
    const [rowB] = addRows(b, data.id, [{ Organisation: 'B' }]);
    const column = addColumn(a, data.id, { name: 'Owner', type: 'text' });
    updateRows(b, data.id, [{ id: data.rows[0].id, values: { Notes: 'edited' } }]);
    sync();
    const read = readDatabase(a);
    expect(read.rows.map((r) => r.id)).toEqual(expect.arrayContaining([rowA, rowB]));
    expect(read.rows).toHaveLength(22);
    expect(read.columns.map((c) => c.id)).toContain(column.id);
    expect(read.rows[0].cells[data.columns[1].id]).toBe('edited');
    expect(readDatabase(b)).toEqual(read);
  });

  it('resolves the same cell edited twice to one value on both sides', () => {
    const { a, b, data, sync } = replicas();
    updateRows(a, data.id, [{ id: data.rows[2].id, values: { Staff: 1 } }]);
    updateRows(b, data.id, [{ id: data.rows[2].id, values: { Staff: 2 } }]);
    sync();
    const value = readDatabase(a).rows[2].cells[data.columns[2].id];
    expect([1, 2]).toContain(value);
    expect(readDatabase(b).rows[2].cells[data.columns[2].id]).toBe(value);
  });

  it('keeps both edits made through ProseMirror transactions (client path)', () => {
    const { a, b, data, sync } = replicas();
    const status = data.columns[3].id;
    const notes = data.columns[1].id;
    pmEdit(a, (state) =>
      state.tr.setNodeAttribute(cellPos(state, data.rows[3].id, status), 'value', 'Partner'),
    );
    pmEdit(b, (state) =>
      state.tr.setNodeAttribute(cellPos(state, data.rows[10].id, notes), 'value', 'B note'),
    );
    // A third, concurrent edit from the server model on another row.
    updateRows(b, data.id, [{ id: data.rows[15].id, values: { Staff: 7 } }]);
    sync();
    for (const doc of [a, b]) {
      const read = readDatabase(doc);
      expect(read.rows[3].cells[status]).toBe('Partner');
      expect(read.rows[10].cells[notes]).toBe('B note');
      expect(read.rows[15].cells[data.columns[2].id]).toBe(7);
    }
    // The PM view of the merged doc agrees with the Yjs read.
    const pmDoc = yXmlFragmentToProseMirrorRootNode(a.getXmlFragment('default'), schema);
    expect(readDatabaseNode(pmDoc.firstChild)).toEqual(readDatabase(a));
  });
});
