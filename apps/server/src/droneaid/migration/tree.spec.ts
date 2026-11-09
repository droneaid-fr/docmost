import { flattenTree, folderCreatedAt, planTree } from './tree';

const doc = (docId: string, createdAt = '2026-01-01T00:00:00Z') =>
  ({ docId, createdAt }) as any;
const link = (targetId: string, index: string, type = 'doc') => ({
  index,
  linkId: `l-${targetId}`,
  targetId,
  title: targetId,
  type,
});

describe('planTree', () => {
  const folders = {
    tree: [
      {
        id: 'f2',
        name: 'Second',
        index: 'b0',
        folders: [],
        items: [link('d3', 'a0'), link('d1', 'a1')],
      },
      {
        id: 'f1',
        name: 'First',
        index: 'a0',
        folders: [{ id: 'f1a', name: 'Sub', index: 'a5', folders: [], items: [link('d2', 'a0')] }],
        items: [link('d1', 'a9'), link('tag1', 'a1', 'tag'), link('gone', 'a2')],
      },
    ],
    looseLinks: [],
    danglingFolders: [],
  } as any;
  const docs = [doc('d1'), doc('d2'), doc('d3'), doc('d5', '2025-01-01T00:00:00Z'), doc('d4', '2026-02-01T00:00:00Z')];
  const plan = planTree(folders, docs);

  it('orders folders and mixed children by index, then unfiled docs oldest first', () => {
    expect(flattenTree(plan.roots).map(({ node, parentKey }) => [node.key, parentKey])).toEqual([
      ['folder:f1', null],
      ['folder:f1a', 'folder:f1'],
      ['doc:d2', 'folder:f1a'],
      ['doc:d1', 'folder:f1'],
      ['folder:f2', null],
      ['doc:d3', 'folder:f2'],
      ['doc:d5', null],
      ['doc:d4', null],
    ]);
  });

  it('places a doc linked twice under the first folder and reports the other', () => {
    expect(plan.extraLinks).toEqual([{ docId: 'd1', keptUnder: ['First'], alsoIn: [['Second']] }]);
  });

  it('reports tag links and links to docs not in the bundle', () => {
    expect(plan.skippedLinks.map((l) => l.targetId)).toEqual(['tag1']);
    expect(plan.missingDocs.map((l) => l.targetId)).toEqual(['gone']);
  });
});

describe('folderCreatedAt', () => {
  it('is the oldest descendant doc', () => {
    const tree = {
      kind: 'folder', key: 'f', folderId: 'f', title: 'F',
      children: [
        { kind: 'doc', key: 'd1', docId: 'd1', children: [] },
        { kind: 'folder', key: 'g', folderId: 'g', title: 'G', children: [{ kind: 'doc', key: 'd2', docId: 'd2', children: [] }] },
      ],
    } as any;
    const dates: Record<string, string> = { d1: '2026-02-01T00:00:00Z', d2: '2026-01-01T00:00:00Z' };
    expect(folderCreatedAt(tree, (id) => dates[id])).toBe('2026-01-01T00:00:00Z');
    expect(folderCreatedAt({ ...tree, children: [] }, () => undefined)).toBeNull();
  });
});
