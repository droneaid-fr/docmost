import { createDatabaseData } from '@docmost/editor-ext';
import { convertMarkdown, editorReady, replaceTokens } from './content';
import { prepareMarkdown } from './markdown-prep';

jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (text: string) => text.toLowerCase().replace(/\s+/g, '-'),
}));

const ATT = '0190f2c4-0000-7000-8000-000000000001';
const PDF = '0190f2c4-0000-7000-8000-000000000002';
const attachments: Record<string, any> = {
  [ATT]: { id: ATT, fileName: 'image-1.png', mimeType: 'image/png', fileSize: 10, workspaceId: 'ws', pageId: 'page-a' },
  [PDF]: { id: PDF, fileName: 'Offer.pdf', mimeType: 'application/pdf', fileSize: 99, workspaceId: 'ws', pageId: 'page-a' },
};
const pages: Record<string, any> = {
  docA: { id: 'page-a', slugId: 'slugA', title: 'Target List', spaceId: 'sp1' },
  docB: { id: 'page-b', slugId: 'slugB', title: 'Other', spaceId: 'sp2' },
};
const deps = {
  baseUrl: '',
  workspaceId: 'ws',
  userId: 'u1',
  pageFor: (ref: string) =>
    pages[ref] ?? Object.values(pages).find((p: any) => p.id === ref) ?? null,
  spaceSlug: (id: string) => ({ sp1: 'france', sp2: 'rnd' })[id] ?? null,
  attachment: async (id: string) => attachments[id] ?? null,
};

const find = (node: any, type: string): any[] =>
  node?.type === type ? [node] : (node?.content ?? []).flatMap((c: any) => find(c, type));

describe('convertMarkdown', () => {
  it('converts links, images, colours, maths, databases and attachments', async () => {
    const db = createDatabaseData({ title: 'People', columns: [{ name: 'Note', type: 'text' }], rows: [{ Name: 'Ann', Note: 'x' }] });
    const body = [
      '# My doc',
      'See [Target List](affine://docA) and [this](affine://docB) and [gone](affine://nope).',
      '',
      '![](blob://key1=)',
      '',
      'Some <span style="color: var(--affine-v2-text-highlight-fg-yellow)">yellow</span> text and $x^2$ inline.',
      '',
      '$$',
      'E = mc^2',
      '$$',
      '',
      `<!-- database id=${db.id} "People" (1 rows, 2 columns): x -->`,
      '',
      '<!-- affine-block id=b1 flavour=affine:attachment blob="key2=" name="Offer.pdf" -->',
    ].join('\n');
    const prep = prepareMarkdown(body, {
      attachmentFor: (key) => ({ 'key1=': ATT, 'key2=': PDF })[key] ?? null,
      titleOf: (id) => pages[id]?.title ?? null,
    });
    const result = await convertMarkdown(prep.markdown, 'My doc', deps, {
      tokens: prep.tokens,
      databases: new Map([[db.id, db]]),
      blobAttachment: (key) => ({ 'key2=': attachments[PDF] })[key] ?? null,
    });
    const { json } = result;
    expect(json.content[0].type).not.toBe('heading'); // title line dropped

    const mention = find(json, 'mention')[0];
    expect(mention.attrs).toMatchObject({ entityType: 'page', entityId: 'page-a', slugId: 'slugA', creatorId: 'u1' });
    const links = JSON.stringify(json);
    expect(links).toContain('/s/rnd/p/other-slugB');
    // A link to a doc outside the bundle keeps its text (reported by the importer).
    expect(links).toContain('and gone.');
    expect(result.linkedPageIds.sort()).toEqual(['page-a', 'page-b']);

    expect(find(json, 'image')[0].attrs).toMatchObject({ src: `/api/files/${ATT}/image-1.png`, attachmentId: ATT });
    expect(links).toContain('"color":"#EAB308"');
    expect(find(json, 'mathInline')[0].attrs.text.trim()).toBe('x^2');
    expect(find(json, 'mathBlock')[0].attrs.text.trim()).toBe('E = mc^2');

    const database = find(json, 'droneaidDatabase')[0];
    expect(database.attrs.id).toBe(db.id);
    expect(find(database, 'droneaidDatabaseRow')).toHaveLength(1);
    expect(find(json, 'attachment')[0].attrs).toMatchObject({
      url: `/api/files/${PDF}/Offer.pdf`,
      name: 'Offer.pdf',
      attachmentId: PDF,
    });
    expect(result.attachmentIds.sort()).toEqual([ATT, PDF]);
    expect(result.databasesPlaced).toEqual([db.id]);
    expect(links).not.toContain('DRONEAID');
  });

  it('appends a database whose marker is missing', async () => {
    const db = createDatabaseData({ title: 'T' });
    const result = await convertMarkdown('Just text', null, deps, {
      tokens: [],
      databases: new Map([[db.id, db]]),
      blobAttachment: () => null,
    });
    expect(result.json.content.at(-2).type).toBe('droneaidDatabase');
    expect(result.json.content.at(-1).type).toBe('paragraph'); // editor's trailing node
    expect(result.warnings[0]).toContain('no marker');
  });

  it('replaceTokens drops unknown-null tokens and keeps the doc valid', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'DRONEAIDMIG:youtube:x' }] }] };
    expect(replaceTokens(doc, () => null)).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(replaceTokens(doc, () => undefined)).toEqual(doc);
  });
});

describe('editorReady', () => {
  it('fills attributes, ids and the trailing paragraph like the editor does', () => {
    let n = 0;
    const out = editorReady(
      { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'H' }] }, { type: 'mathBlock', attrs: { text: 'x' } }] },
      () => `id${++n}`,
    );
    expect(out.attrs).toEqual({ dir: 'auto' });
    expect(out.content[0].attrs).toMatchObject({ id: 'id1', level: 2, dir: 'auto' });
    expect(out.content[1].attrs).toMatchObject({ text: 'x', dir: 'auto' });
    expect(out.content[2]).toMatchObject({ type: 'paragraph', attrs: { id: 'id2' } });
    // idempotent apart from ids already present
    expect(editorReady(out, () => 'never')).toEqual(out);
  });
});
