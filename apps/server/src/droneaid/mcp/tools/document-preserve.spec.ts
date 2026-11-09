import * as Y from 'yjs';
import { ForbiddenException } from '@nestjs/common';
import { Hocuspocus } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { htmlToMarkdown } from '@docmost/editor-ext';
import {
  jsonToHtml,
  tiptapExtensions,
} from '../../../collaboration/collaboration.util';
import { TransclusionService } from '../../../core/page/transclusion/transclusion.service';
import { McpToolContext } from './context';
import { updateDocumentTool } from './document-write';
import { readDocumentTool } from './documents';
import { scanMarkers } from './keep-blocks';
import { liveJson } from './live-doc';
import { preserveUnchanged } from './preserve-blocks';

jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (text: string) => text.toLowerCase().replace(/\s+/g, '-'),
}));

const BASE = 'https://base.example';
const t = (text: string, marks?: any[]) => ({
  type: 'text',
  text,
  ...(marks ? { marks } : {}),
});
const p = (...content: any[]) => ({ type: 'paragraph', content });
const comment = (id: string) => ({
  type: 'comment',
  attrs: { commentId: id, resolved: false },
});

const SOURCE_CONTENT = [p(t('Shared opening hours: 9 to 5'))];
const seedDoc = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { id: 'para1', textAlign: 'center' },
      content: [t('Keep '), t('this sentence', [comment('c-kept')]), t(' as is.')],
    },
    p(t('Rewrite '), t('me please', [comment('c-gone')]), t('.')),
    p(t('State: '), { type: 'status', attrs: { text: 'Done', color: 'green' } }),
    {
      type: 'transclusionSource',
      attrs: { id: 'ts-hours' },
      content: SOURCE_CONTENT,
    },
    {
      type: 'columns',
      attrs: { layout: 'two_equal' },
      content: [
        { type: 'column', content: [p(t('Left side'))] },
        { type: 'column', content: [p(t('Right side'))] },
      ],
    },
    p(t('Tail')),
  ],
};

const instances: Hocuspocus[] = [];
afterAll(async () => {
  for (const instance of instances) {
    instance.closeConnections();
    await instance.flushPendingStores();
  }
});

function setup() {
  const page = {
    id: 'p-1',
    slugId: 'slug1',
    title: 'Hours',
    spaceId: 'sp-agent',
    parentPageId: null,
    workspaceId: 'ws-1',
    deletedAt: null,
    content: seedDoc,
  };
  const hocuspocus = new Hocuspocus({
    quiet: true,
    extensions: [
      {
        async onLoadDocument({ document }: any) {
          const ydoc = TiptapTransformer.toYdoc(seedDoc, 'default', tiptapExtensions);
          Y.applyUpdate(document, Y.encodeStateAsUpdate(ydoc));
        },
      },
    ],
  } as any);
  instances.push(hocuspocus);
  const deps: any = {
    pageRepo: { findById: jest.fn(async () => page) },
    spaceRepo: { findById: jest.fn(async () => ({ id: 'sp-agent', slug: 'agent' })) },
    pageAccess: {
      validateCanView: jest.fn(async () => undefined),
      validateCanEdit: jest.fn(async (pg: any) => {
        if (pg.spaceId !== 'sp-agent') throw new ForbiddenException();
      }),
    },
    pageService: { update: jest.fn(async (pg: any) => pg) },
    exportService: {
      turnPageMentionsToLinks: jest.fn(async (json: any) => json),
      exportPage: jest.fn(async (_f: string, pg: any) =>
        htmlToMarkdown(jsonToHtml(pg.content)),
      ),
    },
    domainService: { getWorkspaceUrl: () => BASE },
    collaborationGateway: {
      lockDocument: jest.fn(async () => undefined),
      openDirectConnection: (name: string, context: any) =>
        hocuspocus.openDirectConnection(name, context),
    },
    environmentService: { isCollabDisableRedis: () => false },
    attachmentRepo: { findById: async () => undefined },
    wsService: { emitToSpaceExceptUsers: jest.fn(async () => undefined) },
    generalQueue: { add: jest.fn(async () => undefined) },
  };
  const ctx = new McpToolContext(
    {
      user: { id: 'agent-1' } as any,
      workspace: { id: 'ws-1' } as any,
      authType: 'droneaid_agent',
      isAgent: true,
      agentSpaceId: 'sp-agent',
    },
    deps,
  );
  return { ctx, hocuspocus };
}

const reply = (result: any) => JSON.parse(result.content[0].text);
const commentIds = (doc: any): string[] => {
  const ids: string[] = [];
  const visit = (n: any) => {
    for (const m of n?.marks ?? []) if (m.type === 'comment') ids.push(m.attrs.commentId);
    (n?.content ?? []).forEach(visit);
  };
  visit(doc);
  return ids;
};

describe('read_document -> update_document round trip', () => {
  it('shows synced blocks and columns between start and end markers', async () => {
    const { ctx } = setup();
    const md = (await readDocumentTool.execute({ docId: 'p-1' }, ctx)).content[0].text;
    expect(md).toMatch(/<!-- synced-block id=ts-hours start: .*-->\n+Shared opening hours/);
    expect(md).toContain('<!-- synced-block id=ts-hours end -->');
    expect(md).toContain('<!-- columns id=1 start: ');
    expect(md).toContain('<!-- columns id=1 end -->');
    const scanned = scanMarkers(md);
    expect([...scanned.regions.keys()]).toEqual(['synced-block:ts-hours', 'columns:1']);
  });

  it('keeps the synced block, its transclusion row, untouched comments and layout', async () => {
    const { ctx, hocuspocus } = setup();
    const editor = await hocuspocus.openDirectConnection('page.p-1', {});
    const md = (await readDocumentTool.execute({ docId: 'p-1' }, ctx)).content[0].text;
    // The agent edits one paragraph and the tail, leaves the rest alone.
    const edited = md
      .replace('Rewrite me please.', 'This paragraph was rewritten.')
      .replace('Tail', 'New tail');

    const out = reply(await updateDocumentTool.execute({ docId: 'p-1', content: edited }, ctx));
    expect(out.success).toBe(true);
    expect(out.kept).toEqual(
      expect.arrayContaining([
        { type: 'transclusionSource', id: 'ts-hours', placement: 'marker' },
        { type: 'columns', id: '1', placement: 'marker' },
      ]),
    );

    const live = liveJson(editor.document);
    expect(live.content.map((n: any) => n.type)).toEqual([
      'paragraph',
      'paragraph',
      'paragraph',
      'transclusionSource',
      'columns',
      'paragraph',
    ]);
    // untouched paragraph: comment mark, alignment and id all survive
    expect(live.content[0].attrs).toMatchObject({ id: 'para1', textAlign: 'center' });
    expect(commentIds(live)).toEqual(['c-kept']);
    // status badge survives on an untouched paragraph
    expect(live.content[2].content[1]).toMatchObject({ type: 'status', attrs: { text: 'Done' } });
    expect(live.content[4].content).toHaveLength(2);
    expect(live.content[5].content[0].text).toBe('New tail');

    // the rewritten commented paragraph is reported
    expect(out.warnings.join('\n')).toContain('c-gone');
    expect(out.warnings.join('\n')).not.toContain('c-kept');

    // core's transclusion sync, run on the stored result, deletes nothing
    const rows = [
      { transclusionId: 'ts-hours', content: { type: 'doc', content: SOURCE_CONTENT } },
    ];
    const repo = {
      findByPageId: jest.fn(async () => rows),
      insert: jest.fn(),
      update: jest.fn(),
      deleteByPageAndTransclusionIds: jest.fn(),
    };
    const service = new TransclusionService(
      null as any,
      repo as any,
      ...(Array(7).fill(null) as [any, any, any, any, any, any, any]),
    );
    const result = await service.syncPageTransclusions('p-1', 'ws-1', live);
    // (an update only refreshes the stored copy with schema defaults)
    expect(result).toMatchObject({ inserted: 0, deleted: 0 });
    expect(repo.deleteByPageAndTransclusionIds).not.toHaveBeenCalled();
    await editor.disconnect();
  });

  it('keeps a synced block whose markers are missing, at the end, and warns on edits inside', async () => {
    const { ctx, hocuspocus } = setup();
    const editor = await hocuspocus.openDirectConnection('page.p-1', {});
    const md = (await readDocumentTool.execute({ docId: 'p-1' }, ctx)).content[0].text;
    const withoutSynced = md.replace(
      /<!-- synced-block id=ts-hours start[\s\S]*?<!-- synced-block id=ts-hours end -->/,
      '',
    );
    const editedColumns = withoutSynced.replace('Left side', 'Left changed');
    const out = reply(
      await updateDocumentTool.execute({ docId: 'p-1', content: editedColumns }, ctx),
    );
    expect(out.kept).toEqual(
      expect.arrayContaining([
        { type: 'transclusionSource', id: 'ts-hours', placement: 'end' },
      ]),
    );
    expect(out.warnings.join('\n')).toMatch(/columns id=1 .*ignored/);
    const live = liveJson(editor.document);
    expect(live.content[live.content.length - 1]).toMatchObject({
      type: 'transclusionSource',
      attrs: { id: 'ts-hours' },
    });
    expect(JSON.stringify(live)).toContain('Left side');
    expect(JSON.stringify(live)).not.toContain('Left changed');
    await editor.disconnect();
  });
});

describe('preserveUnchanged', () => {
  const current = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { id: 'a', textAlign: 'right' },
        content: [t('Hello '), t('world', [comment('c1')])],
      },
      p(t('hl', [{ type: 'highlight', attrs: { color: 'red' } }])),
    ],
  };

  it('reuses a live block Markdown renders the same way, highlight included', () => {
    const incoming = { type: 'doc', content: [p(t('Hello world')), p(t('==hl=='))] };
    const out = preserveUnchanged(current, incoming);
    expect(out.doc.content[0]).toBe(current.content[0]);
    expect(out.doc.content[1]).toBe(current.content[1]);
    expect(out.warnings).toEqual([]);
  });

  it('moves comment marks and attributes onto the same text with new formatting', () => {
    const incoming = {
      type: 'doc',
      content: [p(t('Hello '), t('world', [{ type: 'bold' }]))],
    };
    const out = preserveUnchanged(current, incoming);
    const block = out.doc.content[0];
    expect(block.attrs).toMatchObject({ id: 'a', textAlign: 'right' });
    expect(block.content[1]).toEqual({
      type: 'text',
      text: 'world',
      marks: [{ type: 'bold' }, comment('c1')],
    });
    expect(out.warnings.join()).not.toContain('c1');
  });

  it('reports comments and formatting lost to rewrites', () => {
    const incoming = { type: 'doc', content: [p(t('Goodbye world')), p(t('other'))] };
    const out = preserveUnchanged(current, incoming);
    expect(out.warnings[0]).toContain('c1');
    expect(out.warnings[1]).toMatch(/highlight.*text alignment|text alignment.*highlight/);
  });
});
