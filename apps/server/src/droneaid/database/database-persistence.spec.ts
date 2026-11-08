import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import {
  createDatabaseData,
  databaseToJson,
  findDatabasesInJson,
} from '@docmost/editor-ext';
import {
  jsonToNode,
  tiptapExtensions,
} from '../../collaboration/collaboration.util';
import { createYdocFromJson } from '../../common/helpers/prosemirror/utils';
import { readDatabase, updateRows } from './database-ydoc';
import { targetListSpec } from './database-fixtures';

/**
 * The paths Docmost's persistence uses: `content` JSON -> ydoc on load
 * (persistence.extension onLoadDocument, page duplicate, import), ydoc ->
 * `content` on store. Each must keep a 777 x 8 database whole.
 */
describe('database persistence', () => {
  const data = createDatabaseData(targetListSpec(777));
  const content = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Intro' }] },
      databaseToJson(data),
    ],
  };

  it('has 777 rows and 8 columns of every type', () => {
    expect(data.rows).toHaveLength(777);
    expect(data.columns.map((c) => c.type)).toEqual([
      'title', 'text', 'number', 'select', 'multi-select', 'date', 'checkbox', 'link',
    ]);
  });

  it('survives content -> ydoc -> content (load and store)', () => {
    const ydoc = TiptapTransformer.toYdoc(content, 'default', tiptapExtensions);
    expect(readDatabase(ydoc)).toEqual(data);
    const stored = TiptapTransformer.fromYdoc(ydoc, 'default');
    const [back] = findDatabasesInJson(stored);
    expect(back).toEqual(data);
    // A second load of what was stored is stable.
    const again = TiptapTransformer.fromYdoc(
      TiptapTransformer.toYdoc(stored, 'default', tiptapExtensions),
      'default',
    );
    expect(again).toEqual(stored);
  });

  it('survives the ydoc bytes stored in pages.ydoc', () => {
    const bytes = createYdocFromJson(content);
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, new Uint8Array(bytes));
    expect(readDatabase(ydoc)).toEqual(data);
  });

  it('is kept by the server schema (jsonToNode does not strip it)', () => {
    const node = jsonToNode(content);
    const json = node.toJSON();
    expect(findDatabasesInJson(json)[0]).toEqual(data);
    expect(node.child(1).type.name).toBe('droneaidDatabase');
    expect(node.child(1).childCount).toBe(8 + 777);
  });

  it('stores a server-side edit and loads it back', () => {
    const ydoc = TiptapTransformer.toYdoc(content, 'default', tiptapExtensions);
    updateRows(ydoc, data.id, [{ id: data.rows[500].id, values: { Staff: 4242 } }]);
    const stored = TiptapTransformer.fromYdoc(ydoc, 'default');
    const [back] = findDatabasesInJson(stored);
    expect(back.rows[500].cells[data.columns[2].id]).toBe(4242);
    expect(back.rows).toHaveLength(777);
  });
});
