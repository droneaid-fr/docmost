/**
 * Doc transforms on a synthetic Yjs doc, through the fork's own reader and
 * database model. Run with `./run.sh test` (needs the AFFiNE fork runtime).
 */
import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { docBody, docCanvas, docDatabases, walkBlocks } from '../src/docs.ts';
import { type Fork, loadFork } from '../src/fork.ts';

let fork: Fork;
before(async () => {
  const server = process.env.AFFINE_SERVER;
  assert.ok(server, 'AFFINE_SERVER must point at the fork server package');
  fork = await loadFork(server);
});

function buildDoc() {
  const { Y } = fork;
  const doc = new Y.Doc();
  const blocks = doc.getMap('blocks');
  const add = (id: string, flavour: string, props: Record<string, unknown>, children: string[] = []) => {
    const block = new Y.Map<unknown>();
    blocks.set(id, block);
    block.set('sys:id', id);
    block.set('sys:flavour', flavour);
    block.set('sys:version', 1);
    const kids = new Y.Array<string>();
    block.set('sys:children', kids);
    kids.push(children);
    for (const [key, value] of Object.entries(props)) block.set(`prop:${key}`, value);
    return block;
  };
  const text = (s: string) => new Y.Text(s);
  doc.transact(() => {
    add('page', 'affine:page', { title: text('Synthetic') }, ['surface', 'note1', 'note2']);
    add('surface', 'affine:surface', {}, ['frame1']);
    add('frame1', 'affine:frame', { title: text('F') });
    add('note1', 'affine:note', { displayMode: 'both' }, ['p1', 'img', 'tex', 'yt', 'db']);
    const p1 = add('p1', 'affine:paragraph', { type: 'text', text: new Y.Text() });
    (p1.get('prop:text') as InstanceType<typeof Y.Text>).applyDelta([
      { insert: 'Solve ' },
      { insert: ' ', attributes: { latex: 'x^2' } },
      { insert: ' see ' },
      { insert: ' ', attributes: { reference: { type: 'LinkedPage', pageId: 'other' } } },
    ]);
    add('img', 'affine:image', { sourceId: 'KEY=', caption: 'A cat', width: 10, height: 20 });
    add('tex', 'affine:latex', { latex: 'E=mc^2' });
    add('yt', 'affine:embed-youtube', { url: 'https://www.youtube.com/watch?v=x', title: 'Video' });
    const columns = new Y.Array<unknown>();
    const col = (id: string, type: string, name: string, data?: Record<string, unknown>) => {
      const m = new Y.Map<unknown>();
      m.set('id', id);
      m.set('type', type);
      m.set('name', name);
      const d = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(data ?? {})) d.set(k, v);
      m.set('data', d);
      return m;
    };
    const options = new Y.Array<unknown>();
    for (const [id, value] of [['o1', 'Yes'], ['o2', 'No']]) {
      const o = new Y.Map<unknown>();
      o.set('id', id);
      o.set('value', value);
      o.set('color', 'red');
      options.push([o]);
    }
    columns.push([
      col('c-check', 'checkbox', 'Done'),
      col('c-date', 'date', 'When'),
      col('c-sel', 'select', 'Pick', {}),
    ]);
    const db = add('db', 'affine:database', { title: text('Tasks'), columns, views: new Y.Array() }, ['r1', 'r2']);
    ((columns.get(2) as InstanceType<typeof Y.Map>).get('data') as InstanceType<typeof Y.Map>).set('options', options);
    const cells = new Y.Map<unknown>();
    db.set('prop:cells', cells);
    const cell = (value: unknown) => {
      const m = new Y.Map<unknown>();
      m.set('value', value);
      return m;
    };
    const r1 = new Y.Map<unknown>();
    cells.set('r1', r1);
    r1.set('c-check', cell(true));
    r1.set('c-date', cell(Date.UTC(2026, 10, 8, 23))); // local midnight in Paris, 9 Nov
    r1.set('c-sel', cell('o2'));
    add('r1', 'affine:paragraph', { type: 'text', text: text('Row one') });
    add('r2', 'affine:paragraph', { type: 'text', text: text('Row two') });
    add('note2', 'affine:note', { displayMode: 'edgeless' }, ['p2']);
    add('p2', 'affine:paragraph', { type: 'text', text: text('Only on the canvas') });
  });
  return doc;
}

test('walkBlocks visits in document order and marks canvas and edgeless-only blocks', () => {
  const doc = buildDoc();
  const { order, orphans } = walkBlocks(fork, doc);
  assert.deepEqual(order.map(o => o.id), ['page', 'surface', 'frame1', 'note1', 'p1', 'img', 'tex', 'yt', 'db', 'r1', 'r2', 'note2', 'p2']);
  assert.equal(order.find(o => o.id === 'frame1')?.onCanvas, true);
  assert.equal(order.find(o => o.id === 'p2')?.edgelessOnly, true);
  assert.equal(order.find(o => o.id === 'p1')?.edgelessOnly, false);
  assert.deepEqual(orphans, []);
});

test('docBody places special blocks, rewrites inline latex and links, splits edgeless notes', () => {
  const doc = buildDoc();
  const before = fork.Y.encodeStateAsUpdate(doc);
  const body = docBody(fork, 'ws', 'doc', doc, id => (id === 'other' ? 'Other doc' : undefined));
  const md = body.markdown;
  assert.match(md, /Solve \$x\^2\$ see \[Other doc\]\(affine:\/\/other\)/);
  assert.match(md, /!\[A cat\]\(blob:\/\/KEY=\)/);
  assert.match(md, /\$\$\nE=mc\^2\n\$\$/);
  assert.match(md, /<!-- affine-block id=yt flavour=affine:embed-youtube title="Video" url="https:\/\/www.youtube.com\/watch\?v=x" -->/);
  assert.match(md, /<!-- database id=db "Tasks" \(2 rows, 4 columns\)/);
  assert.ok(!md.includes('Row one'), 'database rows are not printed as text');
  assert.ok(!md.includes('Only on the canvas'), 'edgeless-only notes are not in the page body');
  assert.match(body.edgelessNotesMarkdown ?? '', /Only on the canvas/);
  // Order: image before latex before embed before database.
  const pos = ['blob://KEY=', 'E=mc^2', 'affine-block id=yt', 'database id=db'].map(s => md.indexOf(s));
  assert.deepEqual(pos, [...pos].sort((a, b) => a - b));
  assert.equal(body.inline.inlineLatex, 1);
  assert.equal(body.blocks.find(b => b.id === 'frame1')?.handling, 'canvas');
  assert.deepEqual(body.unplacedSentinels, []);
  // The source doc is untouched.
  assert.deepEqual(fork.Y.encodeStateAsUpdate(doc), before);
});

test('docDatabases follows read_database semantics with every column present', () => {
  const doc = buildDoc();
  const [db] = docDatabases(fork, doc);
  assert.equal(db.databaseId, 'db');
  assert.equal(db.title, 'Tasks');
  assert.deepEqual(db.columns.map(c => [c.id, c.type, c.name]), [
    ['title', 'title', 'Title'],
    ['c-check', 'checkbox', 'Done'],
    ['c-date', 'date', 'When'],
    ['c-sel', 'select', 'Pick'],
  ]);
  assert.deepEqual(db.columns[3].options, ['Yes', 'No']);
  assert.deepEqual(db.rows, [
    { id: 'r1', values: { title: 'Row one', 'c-check': true, 'c-date': '2026-11-09', 'c-sel': 'No' } },
    { id: 'r2', values: { title: 'Row two', 'c-check': false, 'c-date': null, 'c-sel': null } },
  ]);
});

test('docCanvas is null for an empty surface', () => {
  assert.equal(docCanvas(fork, buildDoc()), null);
});
