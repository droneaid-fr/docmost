import * as Y from 'yjs';
import { ForbiddenException } from '@nestjs/common';
import { Hocuspocus } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { createDatabaseData, databaseToJson } from '@docmost/editor-ext';
import { tiptapExtensions } from '../../../collaboration/collaboration.util';
import { readDatabase } from '../../database';
import { McpToolContext } from './context';
import {
  createDocumentTool,
  updateDocumentMetaTool,
  updateDocumentTool,
} from './document-write';
import {
  addToFolderTool,
  createFolderTool,
  moveFolderItemTool,
  removeFromFolderTool,
  renameFolderTool,
} from './folder-write';
import { uploadImageTool } from './images';
import { liveJson } from './live-doc';
import {
  attachmentRefFromSrc,
  pageRefFromHref,
  stripLeadingTitle,
} from './markdown-in';

jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (text: string) => text.toLowerCase().replace(/\s+/g, '-'),
}));

const BASE = 'https://base.example';
const SPACES = [
  { id: 'sp-agent', name: 'Agent Space', slug: 'agent' },
  { id: 'sp-shared', name: 'Shared', slug: 'shared' },
  { id: 'sp-team', name: 'Team', slug: 'team' },
  { id: 'sp-general', name: 'General', slug: 'general' },
];
/** The agent's roles: writer in its space and Team, reader in Shared, none in General. */
const ROLES: Record<string, string> = {
  'sp-agent': 'writer',
  'sp-team': 'writer',
  'sp-shared': 'reader',
};
const UUID = '01a1bd77-0000-7000-8000-000000000001';

const db = createDatabaseData({
  title: 'Guests',
  columns: [{ name: 'Name', type: 'title' }],
  rows: [{ Name: 'Ada' }],
});

type FakePage = Record<string, any>;

function page(id: string, spaceId: string, extra: FakePage = {}): FakePage {
  return {
    id,
    slugId: `${id.replace(/-/g, '')}x`,
    title: id,
    spaceId,
    parentPageId: null,
    workspaceId: 'ws-1',
    deletedAt: null,
    position: 'a0',
    ...extra,
  };
}

/** Chainable stand-in for the few Kysely queries the tools run. */
function fakeDb(results: { rows?: any[]; first?: any }) {
  const calls: any[] = [];
  const qb: any = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'execute') return async () => results.rows ?? [];
        if (prop === 'executeTakeFirst') return async () => results.first;
        if (prop === '$if')
          return (cond: boolean, fn: any) => (cond ? fn(qb) : qb);
        return (...args: any[]) => {
          calls.push([prop, ...args]);
          return qb;
        };
      },
    },
  );
  return { db: qb, calls };
}

const instances: Hocuspocus[] = [];
afterAll(async () => {
  for (const instance of instances) {
    instance.closeConnections();
    await instance.flushPendingStores();
  }
});

function setup(opts: { seed?: Record<string, any> } = {}) {
  const pages = new Map<string, FakePage>(
    [
      page('p-agent', 'sp-agent', { title: 'Agent notes' }),
      page('p-team', 'sp-team', { title: 'Team folder' }),
      page('p-shared', 'sp-shared', { title: 'Opportunities' }),
      page('p-gen', 'sp-general', { title: 'Welcome' }),
    ].map((p) => [p.id, p]),
  );
  const find = (id: string) =>
    [...pages.values()].find((p) => p.id === id || p.slugId === id);

  // Live docs, loaded from `seed` the way PersistenceExtension loads ydoc.
  const seeds = opts.seed ?? {};
  const hocuspocus = new Hocuspocus({
    quiet: true,
    extensions: [
      {
        async onLoadDocument({ documentName, document }: any) {
          const json = seeds[documentName.split('.')[1]];
          if (json) {
            const ydoc = TiptapTransformer.toYdoc(json, 'default', tiptapExtensions);
            Y.applyUpdate(document, Y.encodeStateAsUpdate(ydoc));
          }
        },
      },
    ],
  } as any);
  instances.push(hocuspocus);

  const { db: dbFake, calls: dbCalls } = fakeDb({
    rows: [],
    first: { numUpdatedRows: BigInt(1), position: 'a5' },
  });
  const created: any[] = [];
  const attachments = new Map<string, any>([
    [UUID, { id: UUID, workspaceId: 'ws-1', fileName: 'fig 1.png', pageId: null }],
  ]);

  const deps: any = {
    db: dbFake,
    pageRepo: {
      findById: jest.fn(async (id: string) => find(id)),
    },
    spaceRepo: {
      findById: jest.fn(async (id: string) => SPACES.find((s) => s.id === id)),
    },
    spaceMemberRepo: {
      getUserSpaceIds: jest.fn(async () => Object.keys(ROLES)),
    },
    spaceAbility: {
      createForUser: jest.fn(async (_u: any, spaceId: string) => {
        const role = ROLES[spaceId];
        if (!role) throw new Error('Space permissions not found');
        const can = (action: string) => action === 'read' || role === 'writer';
        return { can, cannot: (a: string) => !can(a) };
      }),
    },
    pageAccess: {
      validateCanView: jest.fn(async (p: any) => {
        if (!ROLES[p.spaceId]) throw new ForbiddenException();
      }),
      validateCanEdit: jest.fn(async (p: any) => {
        if (ROLES[p.spaceId] !== 'writer') throw new ForbiddenException();
      }),
      validateCanCreate: jest.fn(async (spaceId: string) => {
        if (ROLES[spaceId] !== 'writer') throw new ForbiddenException();
      }),
    },
    pagePermissionRepo: {
      filterAccessiblePageIds: jest.fn(async ({ pageIds }: any) => pageIds),
      hasRestrictedPagesInSpace: jest.fn(async () => false),
    },
    pageService: {
      create: jest.fn(async (userId: string, _ws: string, dto: any) => {
        const p = page(`new-${created.length + 1}`, dto.spaceId, {
          title: dto.title,
          parentPageId: dto.parentPageId ?? null,
          creatorId: userId,
          content: dto.content,
        });
        created.push(dto);
        pages.set(p.id, p);
        return p;
      }),
      update: jest.fn(async (p: any, dto: any) => {
        const next = {
          ...p,
          ...(dto.title !== undefined ? { title: dto.title } : {}),
          ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
        };
        pages.set(p.id, next);
        return next;
      }),
      movePage: jest.fn(async (dto: any, moved: any) => {
        pages.set(moved.id, {
          ...moved,
          parentPageId: dto.parentPageId,
          position: dto.position,
        });
      }),
      movePageToSpace: jest.fn(async (moved: any, spaceId: string) => {
        pages.set(moved.id, { ...moved, spaceId, parentPageId: null });
        return { childPageIds: [], deletedShares: [] };
      }),
    },
    domainService: { getWorkspaceUrl: () => BASE },
    collaborationGateway: {
      lockDocument: jest.fn(async () => undefined),
      openDirectConnection: (name: string, context: any) =>
        hocuspocus.openDirectConnection(name, context),
    },
    environmentService: {
      isCollabDisableRedis: () => false,
      getFileUploadSizeLimit: () => '50mb',
    },
    attachmentService: {
      uploadToDrive: jest.fn(async () => undefined),
      saveAttachment: jest.fn(async (o: any) => ({
        id: o.attachmentId,
        fileName: o.preparedFile.fileName,
        pageId: o.pageId ?? null,
        spaceId: o.spaceId,
      })),
    },
    attachmentRepo: {
      findById: jest.fn(async (id: string) => attachments.get(id)),
    },
    wsService: { emitToSpaceExceptUsers: jest.fn(async () => undefined) },
    generalQueue: { add: jest.fn(async () => undefined) },
  };
  const ctx = new McpToolContext(
    {
      user: { id: 'agent-1', name: 'Slavik' } as any,
      workspace: { id: 'ws-1' } as any,
      authType: 'droneaid_agent',
      isAgent: true,
      agentSpaceId: 'sp-agent',
    },
    deps,
  );
  return { ctx, deps, pages, created, hocuspocus, dbCalls };
}

const json = (result: any) => JSON.parse(result.content[0].text);

describe('markdown-in helpers', () => {
  it('reads page references from our URLs and id links', () => {
    expect(pageRefFromHref(`${BASE}/s/team/p/team-folder-abc123`, BASE)).toBe('abc123');
    expect(pageRefFromHref('/p/abc123', BASE)).toBe('abc123');
    expect(pageRefFromHref('affine://p-team', BASE)).toBe('p-team');
    expect(pageRefFromHref('https://other.example/s/x/p/y-1', BASE)).toBeNull();
  });

  it('reads attachment ids from blob keys and file URLs', () => {
    expect(attachmentRefFromSrc(`blob://${UUID}`, BASE)).toEqual({ id: UUID, blob: true });
    expect(attachmentRefFromSrc(`${BASE}/api/files/${UUID}/a.png`, BASE)).toEqual({
      id: UUID,
      blob: false,
    });
    expect(attachmentRefFromSrc('https://cdn.example/a.png', BASE)).toBeNull();
  });

  it('drops a leading H1 only when it repeats the title', () => {
    expect(stripLeadingTitle('# Report\n\nBody', 'report')).toBe('\nBody');
    expect(stripLeadingTitle('# Other\n\nBody', 'Report')).toBe('# Other\n\nBody');
  });
});

describe('create_document', () => {
  it('creates in the agent space by default, with mentions and images', async () => {
    const { ctx, created, dbCalls, deps } = setup();
    const result = await createDocumentTool.execute(
      {
        title: 'Report',
        content: `# Report\n\nSee [Team folder](${BASE}/s/team/p/team-folder-pteamx) and [the call](affine://p-shared).\n\n![](blob://${UUID})`,
      },
      ctx,
    );
    const reply = json(result);
    expect(reply).toMatchObject({ success: true, docId: 'new-1', spaceId: 'sp-agent' });
    expect(reply.linkedPages).toEqual([
      { docId: 'p-team', title: 'Team folder' },
      { docId: 'p-shared', title: 'Opportunities' },
    ]);
    const content = JSON.stringify(created[0].content);
    expect(content).not.toContain('"Report"'); // H1 dropped
    expect(content).toContain('"type":"mention"');
    expect(content).toContain('"entityId":"p-team"');
    expect(content).toContain('/s/shared/p/opportunities-psharedx');
    expect(content).toContain(`/api/files/${UUID}/fig%201.png`);
    expect(content).toContain(`"attachmentId":"${UUID}"`);
    // the uploaded image is attached to the new page
    expect(dbCalls).toContainEqual(['updateTable', 'attachments']);
    expect(deps.wsService.emitToSpaceExceptUsers).toHaveBeenCalled();
    expect(deps.generalQueue.add).toHaveBeenCalledWith(
      'page-backlinks',
      expect.objectContaining({ pageId: 'new-1' }),
    );
  });

  it('files under a folder the agent can edit', async () => {
    const { ctx, created } = setup();
    const reply = json(
      await createDocumentTool.execute(
        { title: 'Child', content: 'x', folder_id: 'p-team' },
        ctx,
      ),
    );
    expect(reply).toMatchObject({ success: true, folderId: 'p-team', spaceId: 'sp-team' });
    expect(created[0]).toMatchObject({ spaceId: 'sp-team', parentPageId: 'p-team' });
  });

  it('refuses General, read-only spaces and read-only folders', async () => {
    const { ctx, created } = setup();
    const general = await createDocumentTool.execute(
      { title: 'x', content: 'x', space_id: 'general' },
      ctx,
    );
    expect(general.isError).toBe(true);
    expect(general.content[0].text).toBe('Space general not found.');
    const shared = await createDocumentTool.execute(
      { title: 'x', content: 'x', space_id: 'shared' },
      ctx,
    );
    expect(shared.content[0].text).toMatch(/only have read access/);
    const folder = await createDocumentTool.execute(
      { title: 'x', content: 'x', folder_id: 'p-shared' },
      ctx,
    );
    expect(folder.content[0].text).toMatch(/only have read access/);
    const genFolder = await createDocumentTool.execute(
      { title: 'x', content: 'x', folder_id: 'p-gen' },
      ctx,
    );
    expect(genFolder.content[0].text).toBe('Doc with id p-gen not found.');
    expect(created).toHaveLength(0);
  });

  it('puts a lone image in its own block, with no empty paragraph', async () => {
    const { ctx, created } = setup();
    await createDocumentTool.execute(
      { title: 'x', content: `Text\n\n![](blob://${UUID})\n\nMore` },
      ctx,
    );
    expect(created[0].content.content.map((n: any) => n.type)).toEqual([
      'paragraph',
      'image',
      'paragraph',
    ]);
  });

  it('warns about an unknown blob and leaves the image out', async () => {
    const { ctx, created } = setup();
    const missing = '01a1bd77-0000-7000-8000-00000000dead';
    const reply = json(
      await createDocumentTool.execute(
        { title: 'x', content: `![](blob://${missing})` },
        ctx,
      ),
    );
    expect(reply.warnings[0]).toMatch(/not found/);
    expect(JSON.stringify(created[0].content)).not.toContain(missing);
  });
});

describe('update_document', () => {
  const seed = {
    'p-agent': {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Old' }] },
        databaseToJson(db),
        { type: 'paragraph', content: [{ type: 'text', text: 'Tail' }] },
      ],
    },
  };

  it('replaces the body through the live doc and keeps the database', async () => {
    const { ctx, deps, hocuspocus } = setup({ seed });
    // An "open editor": a connection that stays on the document.
    const editor = await hocuspocus.openDirectConnection('page.p-agent', {});
    const seen: string[] = [];
    editor.document.on('update', () => seen.push('update'));

    const reply = json(
      await updateDocumentTool.execute(
        {
          docId: 'p-agent',
          content: `# Agent notes\n\nNew text\n\n<!-- database id=${db.id} -->\n\nEnd`,
        },
        ctx,
      ),
    );
    expect(reply).toMatchObject({ success: true, docId: 'p-agent' });
    expect(reply.kept).toEqual([
      { type: 'droneaidDatabase', id: db.id, placement: 'marker' },
    ]);
    expect(seen.length).toBeGreaterThan(0);
    const live = liveJson(editor.document);
    expect(live.content.map((n: any) => n.type)).toEqual([
      'paragraph',
      'droneaidDatabase',
      'paragraph',
    ]);
    expect(live.content[0].content[0].text).toBe('New text');
    expect(readDatabase(editor.document)).toEqual(db);
    expect(deps.collaborationGateway.lockDocument).toHaveBeenCalledWith('page.p-agent');
    // title untouched unless given
    expect(deps.pageService.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p-agent' }),
      { pageId: 'p-agent', title: undefined },
      expect.anything(),
    );
    await editor.disconnect();
  });

  it('keeps a database whose marker is missing, at the end', async () => {
    const { ctx, hocuspocus } = setup({ seed });
    const editor = await hocuspocus.openDirectConnection('page.p-agent', {});
    const reply = json(
      await updateDocumentTool.execute({ docId: 'p-agent', content: 'Only' }, ctx),
    );
    expect(reply.kept[0].placement).toBe('end');
    expect(liveJson(editor.document).content.map((n: any) => n.type)).toEqual([
      'paragraph',
      'droneaidDatabase',
    ]);
    await editor.disconnect();
  });

  it('refuses read-only and invisible documents without writing', async () => {
    const { ctx, deps } = setup({ seed });
    const shared = await updateDocumentTool.execute(
      { docId: 'p-shared', content: 'x' },
      ctx,
    );
    expect(shared.content[0].text).toMatch(/only have read access/);
    const general = await updateDocumentTool.execute(
      { docId: 'p-gen', content: 'x' },
      ctx,
    );
    expect(general.content[0].text).toBe('Doc with id p-gen not found.');
    expect(deps.collaborationGateway.lockDocument).not.toHaveBeenCalled();
  });

  it('refuses when another collaboration server holds the doc', async () => {
    const { ctx, deps } = setup({ seed });
    deps.collaborationGateway.lockDocument.mockRejectedValue(new Error('locked'));
    const result = await updateDocumentTool.execute(
      { docId: 'p-agent', content: 'x' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/another collaboration server/);
  });
});

describe('update_document_meta', () => {
  it('renames and sets the icon', async () => {
    const { ctx, deps } = setup();
    const reply = json(
      await updateDocumentMetaTool.execute(
        { docId: 'p-agent', title: '  New  name ', icon: '🚁' },
        ctx,
      ),
    );
    expect(reply).toMatchObject({ success: true, title: 'New name', icon: '🚁' });
    expect(deps.wsService.emitToSpaceExceptUsers).toHaveBeenCalledWith(
      'sp-agent',
      [],
      expect.objectContaining({ operation: 'updateOne', id: 'p-agent' }),
    );
  });

  it('clears the icon with "" and refuses read-only pages', async () => {
    const { ctx } = setup();
    expect(
      json(await updateDocumentMetaTool.execute({ docId: 'p-agent', icon: '' }, ctx)).icon,
    ).toBeNull();
    const refused = await updateDocumentMetaTool.execute(
      { docId: 'p-shared', title: 'x' },
      ctx,
    );
    expect(refused.isError).toBe(true);
  });
});

describe('folder tools (page tree)', () => {
  it('create_folder makes a page, or returns the existing one', async () => {
    const { ctx, created } = setup();
    const reply = json(await createFolderTool.execute({ name: 'Events' }, ctx));
    expect(reply).toMatchObject({ success: true, folderId: 'new-1', created: true });
    expect(created[0]).toMatchObject({ title: 'Events', spaceId: 'sp-agent' });

    const { ctx: ctx2, deps } = setup();
    deps.db = fakeDb({ rows: [{ id: 'p-agent' }] }).db;
    expect(json(await createFolderTool.execute({ name: 'Agent notes' }, ctx2))).toEqual({
      success: true,
      folderId: 'p-agent',
      id: 'p-agent',
      created: false,
    });
  });

  it('create_folder is refused where the agent cannot write', async () => {
    const { ctx } = setup();
    const result = await createFolderTool.execute({ name: 'x', parent_id: 'p-shared' }, ctx);
    expect(result.isError).toBe(true);
  });

  it('rename_folder renames the page', async () => {
    const { ctx, pages } = setup();
    expect(json(await renameFolderTool.execute({ folder_id: 'p-team', name: 'Events' }, ctx)))
      .toEqual({ success: true, folderId: 'p-team' });
    expect(pages.get('p-team').title).toBe('Events');
  });

  it('move_folder_item moves within a space and into another writable space', async () => {
    const { ctx, deps, pages } = setup();
    expect(
      json(await moveFolderItemTool.execute({ item_id: 'p-agent', parent_id: 'p-team' }, ctx)),
    ).toEqual({ success: true, itemId: 'p-agent', parentId: 'p-team', spaceId: 'sp-team' });
    expect(deps.pageService.movePageToSpace).toHaveBeenCalled();
    expect(pages.get('p-agent')).toMatchObject({ spaceId: 'sp-team', parentPageId: 'p-team' });
  });

  it('move_folder_item is refused into read-only spaces and for read-only pages', async () => {
    const { ctx, deps } = setup();
    const into = await moveFolderItemTool.execute(
      { item_id: 'p-agent', space_id: 'shared' },
      ctx,
    );
    expect(into.content[0].text).toMatch(/only have read access/);
    const own = await moveFolderItemTool.execute({ item_id: 'p-shared' }, ctx);
    expect(own.content[0].text).toMatch(/only have read access/);
    const self = await moveFolderItemTool.execute(
      { item_id: 'p-agent', parent_id: 'p-agent' },
      ctx,
    );
    expect(self.content[0].text).toMatch(/under itself/);
    expect(deps.pageService.movePage).not.toHaveBeenCalled();
  });

  it('add_to_folder moves the doc; remove_from_folder moves it to the top', async () => {
    const { ctx, pages } = setup();
    expect(
      json(await addToFolderTool.execute({ folder_id: 'p-team', target_id: 'p-agent' }, ctx)),
    ).toMatchObject({ success: true, linkId: 'p-agent', moved: true, parentId: 'p-team' });
    expect(
      json(await removeFromFolderTool.execute({ link_id: 'p-agent' }, ctx)),
    ).toMatchObject({ success: true, linkId: 'p-agent', parentId: null, spaceId: 'sp-team' });
    expect(pages.get('p-agent').parentPageId).toBeNull();
    const tag = await addToFolderTool.execute(
      { folder_id: 'p-team', target_id: 'x', type: 'tag' },
      ctx,
    );
    expect(tag.isError).toBe(true);
  });
});

describe('upload_image', () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');

  it('stores the image through the attachment service, unattached until used', async () => {
    const { ctx, deps } = setup();
    const reply = json(
      await uploadImageTool.execute({ data_base64: png, mime_type: 'image/png' }, ctx),
    );
    expect(reply.success).toBe(true);
    expect(reply.markdown).toBe(`![](${reply.url})`);
    expect(reply.url).toMatch(new RegExp(`^/api/files/${reply.key}/image-.*\\.png$`));
    const saved = deps.attachmentService.saveAttachment.mock.calls[0][0];
    expect(saved).toMatchObject({
      type: 'file',
      userId: 'agent-1',
      spaceId: 'sp-agent',
      pageId: undefined,
    });
    expect(deps.attachmentService.uploadToDrive.mock.calls[0][0]).toBe(saved.filePath);
  });

  it('attaches to doc_id when given, and refuses read-only docs', async () => {
    const { ctx, deps } = setup();
    const reply = json(
      await uploadImageTool.execute(
        { data_base64: png, mime_type: 'image/png', doc_id: 'p-team' },
        ctx,
      ),
    );
    expect(reply.docId).toBe('p-team');
    const refused = await uploadImageTool.execute(
      { data_base64: png, mime_type: 'image/png', doc_id: 'p-shared' },
      ctx,
    );
    expect(refused.isError).toBe(true);
    expect(deps.attachmentService.saveAttachment).toHaveBeenCalledTimes(1);
  });

  it('enforces the size cap and the image types', async () => {
    const { ctx } = setup();
    const big = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
    const tooBig = await uploadImageTool.execute(
      { data_base64: big, mime_type: 'image/png' },
      ctx,
    );
    expect(tooBig.content[0].text).toMatch(/larger than/);
    expect(
      uploadImageTool.inputSchema.safeParse({ data_base64: 'x', mime_type: 'text/html' })
        .success,
    ).toBe(false);
  });
});
