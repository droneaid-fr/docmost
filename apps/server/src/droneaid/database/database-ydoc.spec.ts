import * as Y from 'yjs';
import { DatabaseError } from '@docmost/editor-ext';
import {
  addColumn,
  addRows,
  createDatabase,
  findDatabases,
  readDatabase,
  removeColumn,
  removeRows,
  renameColumn,
  resolveDatabase,
  retypeColumn,
  setColumnOptions,
  setDatabaseTitle,
  updateRows,
} from './database-ydoc';

function newDoc() {
  const doc = new Y.Doc();
  const p = new Y.XmlElement('paragraph');
  doc.getXmlFragment('default').insert(0, [p]);
  return doc;
}

function seeded() {
  const doc = newDoc();
  const data = createDatabase(doc, {
    title: 'Guests',
    columns: [
      { name: 'Age', type: 'number' },
      { name: 'Status', type: 'select', options: ['In'] },
      { name: 'Tags', type: 'multi-select' },
      { name: 'Note', type: 'text' },
    ],
    rows: [
      { Name: 'Ann', Age: 30, Status: 'In', Note: '42' },
      { Name: 'Bob', Age: '41', Tags: 'a, b' },
    ],
  });
  return { doc, data };
}

describe('database ydoc model', () => {
  it('creates a database at the end of the page and reads it back typed', () => {
    const { doc, data } = seeded();
    const fragment = doc.getXmlFragment('default');
    expect(fragment.length).toBe(2);
    expect((fragment.get(1) as Y.XmlElement).nodeName).toBe('droneaidDatabase');
    const read = readDatabase(doc);
    expect(read).toEqual(data);
    expect(read.rows[1].cells[read.columns[1].id]).toBe(41);
    expect(read.columns[3].options.map((o) => o.label)).toEqual(['a', 'b']);
  });

  it('creates before a trailing footnotes block and at an index', () => {
    const doc = newDoc();
    doc.getXmlFragment('default').insert(1, [new Y.XmlElement('footnotes')]);
    createDatabase(doc, {});
    createDatabase(doc, {}, { index: 0 });
    const names = doc
      .getXmlFragment('default')
      .toArray()
      .map((e) => (e as Y.XmlElement).nodeName);
    expect(names).toEqual(['droneaidDatabase', 'paragraph', 'droneaidDatabase', 'footnotes']);
    expect(findDatabases(doc)).toHaveLength(2);
    expect(() => resolveDatabase(doc)).toThrow(/2 databases/);
  });

  it('finds nested databases and resolves by id', () => {
    const doc = newDoc();
    const db = createDatabase(doc, { title: 'X' });
    const fragment = doc.getXmlFragment('default');
    const el = fragment.get(1) as Y.XmlElement;
    const clone = el.clone();
    const wrapper = new Y.XmlElement('column');
    wrapper.insert(0, [clone]);
    doc.transact(() => {
      fragment.delete(1, 1);
      fragment.insert(1, [wrapper]);
    });
    expect(resolveDatabase(doc, db.id).title).toBe('X');
    expect(() => resolveDatabase(doc, 'nope')).toThrow(/not found/);
    expect(() => resolveDatabase(newDoc())).toThrow(/no database/);
  });

  it('adds rows after the last row or after a given row, in one transaction', () => {
    const { doc, data } = seeded();
    let transactions = 0;
    doc.on('afterTransaction', () => transactions++);
    const [first] = addRows(doc, data.id, [{ Name: 'Cy', Status: 'Out' }]);
    const [second] = addRows(doc, data.id, [{ Name: 'Di' }], { afterRowId: data.rows[0].id });
    expect(transactions).toBe(2);
    const read = readDatabase(doc);
    expect(read.rows.map((r) => r.id)).toEqual([data.rows[0].id, second, data.rows[1].id, first]);
    expect(read.columns[2].options.map((o) => o.label)).toEqual(['In', 'Out']);
  });

  it('validates every row before writing anything', () => {
    const { doc, data } = seeded();
    const before = Y.encodeStateVector(doc);
    expect(() => addRows(doc, data.id, [{ Name: 'ok' }, { Age: 'old' }])).toThrow(DatabaseError);
    expect(() => addRows(doc, data.id, [{ Missing: 1 }])).toThrow(/Unknown column/);
    expect(() => addRows(doc, data.id, [], { afterRowId: 'x' })).toThrow(/not found/);
    expect(Y.encodeStateVector(doc)).toEqual(before);
    expect(readDatabase(doc).rows).toHaveLength(2);
  });

  it('updates cells, clears them and leaves others unchanged', () => {
    const { doc, data } = seeded();
    const [ann, bob] = data.rows;
    updateRows(doc, data.id, [
      { id: ann.id, values: { Age: null, Tags: ['x'] } },
      { id: bob.id, values: { status: 'In', Note: 'hi' } },
    ]);
    const read = readDatabase(doc);
    const [age, status, tags, note] = read.columns.slice(1).map((c) => c.id);
    expect(read.rows[0].cells).toEqual({
      [read.columns[0].id]: 'Ann',
      [status]: 'In',
      [tags]: ['x'],
      [note]: '42',
    });
    expect(read.rows[0].cells[age]).toBeUndefined();
    expect(read.rows[1].cells[status]).toBe('In');
    expect(read.rows[1].cells[note]).toBe('hi');
    expect(() => updateRows(doc, data.id, [{ id: 'nope', values: {} }])).toThrow(/not found/);
  });

  it('collapses duplicate cells for one column (the last one wins on read)', () => {
    const { doc, data } = seeded();
    const db = resolveDatabase(doc, data.id).element;
    const row = db.toArray().find(
      (e) => (e as Y.XmlElement).getAttribute('id') === data.rows[0].id,
    ) as Y.XmlElement;
    const dup = new Y.XmlElement('droneaidDatabaseCell');
    dup.setAttribute('column', data.columns[1].id);
    dup.setAttribute('value', 99 as any);
    row.insert(row.length, [dup]);
    expect(readDatabase(doc).rows[0].cells[data.columns[1].id]).toBe(99);
    updateRows(doc, data.id, [{ id: data.rows[0].id, values: { Age: 5 } }]);
    const cells = row.toArray().filter(
      (c) => (c as Y.XmlElement).getAttribute('column') === data.columns[1].id,
    );
    expect(cells).toHaveLength(1);
    expect(readDatabase(doc).rows[0].cells[data.columns[1].id]).toBe(5);
  });

  it('removes rows', () => {
    const { doc, data } = seeded();
    expect(removeRows(doc, data.id, [data.rows[0].id])).toBe(1);
    expect(readDatabase(doc).rows.map((r) => r.id)).toEqual([data.rows[1].id]);
    expect(() => removeRows(doc, data.id, ['x'])).toThrow(/not found/);
  });

  it('adds, renames and removes columns', () => {
    const { doc, data } = seeded();
    const due = addColumn(doc, data.id, { name: 'Due', type: 'date' }, { index: 1 });
    let read = readDatabase(doc);
    expect(read.columns.map((c) => c.name)).toEqual(['Name', 'Due', 'Age', 'Status', 'Tags', 'Note']);
    expect(() => addColumn(doc, data.id, { name: 'due', type: 'text' })).toThrow(/exists/);
    expect(() => addColumn(doc, data.id, { name: 'T', type: 'title' })).toThrow(/one title/);
    renameColumn(doc, data.id, 'Due', 'Deadline');
    expect(() => renameColumn(doc, data.id, 'Deadline', 'age')).toThrow(/exists/);
    removeColumn(doc, data.id, 'Age');
    expect(() => removeColumn(doc, data.id, 'Name')).toThrow(/cannot be removed/);
    read = readDatabase(doc);
    expect(read.columns.map((c) => c.name)).toEqual(['Name', 'Deadline', 'Status', 'Tags', 'Note']);
    expect(read.columns[1].id).toBe(due.id);
    // The removed column's cells are gone from the tree, not just ignored.
    const db = resolveDatabase(doc, data.id).element;
    const orphans = db
      .toArray()
      .flatMap((r) => (r as Y.XmlElement).toArray())
      .filter((c) => (c as Y.XmlElement).getAttribute?.('column') === data.columns[1].id);
    expect(orphans).toHaveLength(0);
  });

  it('retypes a column, converting values leniently', () => {
    const { doc, data } = seeded();
    retypeColumn(doc, data.id, 'Note', 'number');
    let read = readDatabase(doc);
    const note = data.columns[4].id;
    expect(read.columns[4].type).toBe('number');
    expect(read.rows[0].cells[note]).toBe(42);
    retypeColumn(doc, data.id, 'Age', 'select');
    read = readDatabase(doc);
    expect(read.columns[1].options.map((o) => o.label)).toEqual(['30', '41']);
    expect(read.rows[1].cells[data.columns[1].id]).toBe('41');
    expect(() => retypeColumn(doc, data.id, 'Name', 'text')).toThrow(/title/);
    expect(() => retypeColumn(doc, data.id, 'Age', 'title')).toThrow(/title/);
  });

  it('replaces options with renames', () => {
    const { doc, data } = seeded();
    setColumnOptions(doc, data.id, 'Tags', ['alpha', 'b'], { renames: { a: 'alpha' } });
    const read = readDatabase(doc);
    expect(read.rows[1].cells[data.columns[3].id]).toEqual(['alpha', 'b']);
    setColumnOptions(doc, data.id, 'Tags', ['b'], { clearRemoved: true });
    expect(readDatabase(doc).rows[1].cells[data.columns[3].id]).toEqual(['b']);
    expect(() => setColumnOptions(doc, data.id, 'Age', [])).toThrow(/no options/);
  });

  it('sets the title', () => {
    const { doc, data } = seeded();
    setDatabaseTitle(doc, data.id, ' New ');
    expect(readDatabase(doc).title).toBe('New');
  });
});
