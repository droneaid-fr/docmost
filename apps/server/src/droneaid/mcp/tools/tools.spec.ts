import { ForbiddenException } from '@nestjs/common';
import {
  getDocumentInfoTool,
  listDocumentsTool,
  readDocumentTool,
} from './documents';
import { anyWordQuery, docSearchTool, plainExcerpt } from './search';
import { buildTree, listFoldersTool } from './folders';
import { toolsForCaller } from './define';
import { ALL_TOOLS } from './index';
import {
  absolutizeInternalLinks,
  replaceDatabaseNodes,
  restoreDatabaseMarkers,
} from './markdown';
import { McpToolContext } from './context';
import { isMcpRoute } from '../mcp-body-limit';
import { markdownLink, pageUrl } from './page-url';

jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (text: string) => text.toLowerCase().replace(/\s+/g, '-'),
}));

const BASE = 'https://base.example';
const WS = { id: 'ws-1' } as any;
const SPACES = {
  agent: { id: 'sp-agent', name: 'Agent Space', slug: 'agent' },
  shared: { id: 'sp-shared', name: 'Shared', slug: 'shared' },
  general: { id: 'sp-general', name: 'General', slug: 'general' },
};
const ROLES: Record<string, string> = {
  'sp-agent': 'writer',
  'sp-shared': 'reader',
};

const PAGES = [
  {
    id: 'p-root',
    slugId: 'root1',
    title: 'Opportunities',
    spaceId: 'sp-shared',
    parentPageId: null,
    position: 'a0',
  },
  {
    id: 'p-child',
    slugId: 'child1',
    title: 'Hermes call',
    spaceId: 'sp-shared',
    parentPageId: 'p-root',
    position: 'a0',
  },
  {
    id: 'p-agent',
    slugId: 'agent1',
    title: 'Agent notes',
    spaceId: 'sp-agent',
    parentPageId: null,
    position: 'a0',
  },
  {
    id: 'p-gen',
    slugId: 'gen1',
    title: 'General welcome',
    spaceId: 'sp-general',
    parentPageId: null,
    position: 'a0',
  },
].map((p) => ({
  ...p,
  workspaceId: 'ws-1',
  deletedAt: null,
  createdAt: new Date('2026-11-01'),
  updatedAt: new Date('2026-11-02'),
  content: { type: 'doc', content: [] },
}));

/** Minimal Kysely-like query builder over PAGES, enough for the tools. */
function fakeDb() {
  return {
    selectFrom: () => {
      let rows = [...PAGES];
      const qb: any = {
        where: (col: string, op: string, val: any) => {
          rows = rows.filter((r: any) => {
            const v = typeof col === 'string' ? r[col] : undefined;
            if (op === '=') return v === val;
            if (op === 'in') return val.includes(v);
            if (op === 'is') return v === val;
            if (op === 'ilike')
              return String(v)
                .toLowerCase()
                .includes(String(val).replace(/%/g, '').toLowerCase());
            return true;
          });
          return qb;
        },
        $if: (cond: boolean, fn: any) => (cond ? fn(qb) : qb),
        select: () => qb,
        orderBy: () => qb,
        execute: async () => rows,
      };
      return qb;
    },
  };
}

function makeCtx(opts: { isAgent?: boolean } = {}) {
  const spaceAbility = {
    createForUser: jest.fn(async (_u: any, spaceId: string) => {
      const role = ROLES[spaceId];
      if (!role) throw new Error('Space permissions not found');
      return {
        can: (action: string) => action === 'read' || role === 'writer',
        cannot: (action: string) => !(action === 'read' || role === 'writer'),
      };
    }),
  };
  const deps: any = {
    db: fakeDb(),
    spaceMemberRepo: {
      getUserSpaceIds: jest.fn().mockResolvedValue(['sp-agent', 'sp-shared']),
    },
    spaceRepo: {
      findById: jest.fn(async (id: string) =>
        Object.values(SPACES).find((s) => s.id === id),
      ),
    },
    spaceAbility,
    pageRepo: {
      findById: jest.fn(async (id: string) => {
        const page = PAGES.find((p) => p.id === id || p.slugId === id);
        if (!page) return undefined;
        const space = Object.values(SPACES).find((s) => s.id === page.spaceId);
        return {
          ...page,
          space,
          creator: { id: 'u-admin', name: 'Admin' },
          lastUpdatedBy: { id: 'u-admin', name: 'Admin' },
        };
      }),
    },
    pageAccess: {
      validateCanView: jest.fn(async (page: any) => {
        if (!ROLES[page.spaceId]) throw new ForbiddenException();
      }),
      validateCanEdit: jest.fn(async (page: any) => {
        if (ROLES[page.spaceId] !== 'writer') throw new ForbiddenException();
      }),
      validateCanCreate: jest.fn(async (spaceId: string) => {
        if (ROLES[spaceId] !== 'writer') throw new ForbiddenException();
      }),
    },
    pagePermissionRepo: {
      filterAccessiblePageIds: jest.fn(async ({ pageIds }: any) => pageIds),
    },
    pageService: {
      getPageBreadCrumbs: jest.fn(async (id: string) =>
        id === 'p-child'
          ? [PAGES[0], PAGES[1]]
          : [PAGES.find((p) => p.id === id)],
      ),
    },
    searchService: {
      searchPage: jest.fn(async () => ({
        items: [
          {
            id: 'p-child',
            slugId: 'child1',
            title: 'Hermes call',
            highlight: 'about <b>drones</b>',
            space: SPACES.shared,
          },
          {
            id: 'p-agent',
            slugId: 'agent1',
            title: 'Agent notes',
            highlight: '<b>drones</b> notes',
            space: SPACES.agent,
          },
        ],
      })),
    },
    exportService: {
      turnPageMentionsToLinks: jest.fn(async (json: any) => json),
      exportPage: jest.fn(
        async (_f: string, page: any) =>
          `# ${page.title}\n\nSee [x](/s/shared/p/x-1)`,
      ),
    },
    domainService: { getWorkspaceUrl: () => BASE },
  };
  const ctx = new McpToolContext(
    {
      user: { id: 'agent-1' } as any,
      workspace: WS,
      authType: 'droneaid_agent',
      isAgent: opts.isAgent ?? true,
    },
    deps,
  );
  return { ctx, deps };
}

const json = (r: any) => JSON.parse(r.content[0].text);

describe('tool registry', () => {
  it('declares access and audience on every tool; S3a tools are read-only and agent-callable', () => {
    expect(ALL_TOOLS.map((t) => t.name).sort()).toEqual([
      'add_database_rows',
      'add_to_folder',
      'create_database',
      'create_document',
      'create_folder',
      'doc_search',
      'get_document_info',
      'list_documents',
      'list_folders',
      'move_folder_item',
      'read_database',
      'read_document',
      'remove_database_rows',
      'remove_from_folder',
      'rename_folder',
      'update_database_columns',
      'update_database_rows',
      'update_document',
      'update_document_meta',
      'upload_image',
    ]);
    const reads = new Set([
      'doc_search',
      'get_document_info',
      'list_documents',
      'list_folders',
      'read_database',
      'read_document',
    ]);
    for (const tool of ALL_TOOLS) {
      expect(tool.access).toBe(reads.has(tool.name) ? 'read' : 'write');
      expect(tool.audience).toBe('all');
    }
  });

  it('hides human-only tools from agents', () => {
    const human = {
      ...ALL_TOOLS[0],
      name: 'trash',
      audience: 'human' as const,
    };
    expect(
      toolsForCaller([...ALL_TOOLS, human], true).map((t) => t.name),
    ).not.toContain('trash');
    expect(
      toolsForCaller([...ALL_TOOLS, human], false).map((t) => t.name),
    ).toContain('trash');
  });
});

describe('McpToolContext permissions (Docmost CASL)', () => {
  it('lists only spaces with a role, with write flag from the ability', async () => {
    const { ctx } = makeCtx();
    expect(await ctx.readableSpaces()).toEqual([
      { id: 'sp-agent', name: 'Agent Space', slug: 'agent', canWrite: true },
      { id: 'sp-shared', name: 'Shared', slug: 'shared', canWrite: false },
    ]);
  });

  it('cannot read a page in an unshared space (General)', async () => {
    const { ctx } = makeCtx();
    expect(await ctx.findReadablePage('p-gen')).toBeNull();
    expect(await ctx.findReadablePage('p-child')).not.toBeNull();
  });

  it('can write only in its own space', async () => {
    const { ctx } = makeCtx();
    const page = (id: string) => PAGES.find((p) => p.id === id) as any;
    expect(await ctx.canEditPage(page('p-agent'))).toBe(true);
    expect(await ctx.canEditPage(page('p-child'))).toBe(false);
    expect(await ctx.canEditPage(page('p-gen'))).toBe(false);
    expect(await ctx.canCreateInSpace('sp-agent')).toBe(true);
    expect(await ctx.canCreateInSpace('sp-general')).toBe(false);
  });

  it('skips the permission cache after a default-group heal', async () => {
    const { deps } = makeCtx();
    const healed = new McpToolContext(
      {
        user: { id: 'a' } as any,
        workspace: WS,
        authType: 'droneaid_agent',
        isAgent: true,
        skipPermissionCache: true,
      },
      deps,
    );
    await healed.readableSpaces();
    expect(deps.spaceAbility.createForUser).toHaveBeenCalledWith(
      expect.anything(),
      'sp-agent',
      { skipCache: true },
    );
  });
});

describe('read_document', () => {
  it('returns markdown with absolute page links', async () => {
    const { ctx } = makeCtx();
    const result = await readDocumentTool.execute({ docId: 'child1' }, ctx);
    expect(result.content[0].text).toBe(
      `# Hermes call\n\nSee [x](${BASE}/s/shared/p/x-1)`,
    );
  });

  it('answers "not found" for a page the caller cannot read', async () => {
    const { ctx } = makeCtx();
    const result = await readDocumentTool.execute({ docId: 'p-gen' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Doc with id p-gen not found.');
  });
});

describe('list_documents', () => {
  it('lists readable pages with [Title](url) links', async () => {
    const { ctx } = makeCtx();
    const out = json(await listDocumentsTool.execute({}, ctx));
    expect(out.total).toBe(3);
    expect(out.documents.map((d: any) => d.id).sort()).toEqual([
      'p-agent',
      'p-child',
      'p-root',
    ]);
    const child = out.documents.find((d: any) => d.id === 'p-child');
    expect(child.link).toBe(
      `[Hermes call](${BASE}/s/shared/p/hermes-call-child1)`,
    );
    expect(child.parentId).toBe('p-root');
  });

  it('filters by space and parent, pages with limit/offset', async () => {
    const { ctx } = makeCtx();
    const children = json(
      await listDocumentsTool.execute({ parent_id: 'p-root' }, ctx),
    );
    expect(children.documents.map((d: any) => d.id)).toEqual(['p-child']);
    const roots = json(
      await listDocumentsTool.execute(
        { space_id: 'shared', parent_id: 'root' },
        ctx,
      ),
    );
    expect(roots.documents.map((d: any) => d.id)).toEqual(['p-root']);
    const paged = json(
      await listDocumentsTool.execute({ limit: 1, offset: 1 }, ctx),
    );
    expect(paged.total).toBe(3);
    expect(paged.documents).toHaveLength(1);
  });

  it('refuses an unshared space and a parent in it', async () => {
    const { ctx } = makeCtx();
    expect(
      (await listDocumentsTool.execute({ space_id: 'general' }, ctx)).isError,
    ).toBe(true);
    expect(
      (await listDocumentsTool.execute({ parent_id: 'p-gen' }, ctx)).isError,
    ).toBe(true);
    expect(
      (await listDocumentsTool.execute({ parent_id: 'root' }, ctx)).isError,
    ).toBe(true);
  });
});

describe('get_document_info', () => {
  it('returns ids, space, parent, path, creator and edit right', async () => {
    const { ctx } = makeCtx();
    const out = json(
      await getDocumentInfoTool.execute({ docId: 'p-child' }, ctx),
    );
    expect(out).toMatchObject({
      id: 'p-child',
      slugId: 'child1',
      title: 'Hermes call',
      url: `${BASE}/s/shared/p/hermes-call-child1`,
      space: { id: 'sp-shared', slug: 'shared' },
      parent: { id: 'p-root', title: 'Opportunities' },
      path: ['Opportunities'],
      createdBy: { id: 'u-admin', name: 'Admin' },
      canEdit: false,
    });
    expect(out.createdAt).toBe('2026-11-01T00:00:00.000Z');
  });

  it('is "not found" outside the caller\'s spaces', async () => {
    const { ctx } = makeCtx();
    expect(
      (await getDocumentInfoTool.execute({ docId: 'p-gen' }, ctx)).isError,
    ).toBe(true);
  });
});

describe('doc_search', () => {
  it('uses core search scoped to the caller and returns links and excerpts', async () => {
    const { ctx, deps } = makeCtx();
    const out = json(await docSearchTool.execute({ query: 'drones' }, ctx));
    expect(deps.searchService.searchPage).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'drones',
        spaceId: undefined,
        limit: 10,
      }),
      { userId: 'agent-1', workspaceId: 'ws-1' },
    );
    expect(out.hits[0]).toMatchObject({
      doc_id: 'p-child',
      link: `[Hermes call](${BASE}/s/shared/p/hermes-call-child1)`,
      excerpt: 'about **drones**',
    });
  });

  it('filters by space and doc ids; refuses an unshared space', async () => {
    const { ctx, deps } = makeCtx();
    const out = json(
      await docSearchTool.execute({ query: 'd', doc_ids: ['p-agent'] }, ctx),
    );
    expect(out.hits.map((h: any) => h.doc_id)).toEqual(['p-agent']);
    await docSearchTool.execute({ query: 'd', space_id: 'shared' }, ctx);
    expect(deps.searchService.searchPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ spaceId: 'sp-shared' }),
      expect.anything(),
    );
    expect(
      (await docSearchTool.execute({ query: 'd', space_id: 'general' }, ctx))
        .isError,
    ).toBe(true);
  });

  it('accepts a space name as space_id', async () => {
    const { ctx, deps } = makeCtx();
    await docSearchTool.execute({ query: 'd', space_id: 'shared ' }, ctx);
    await docSearchTool.execute({ query: 'd', space_id: 'SHARED' }, ctx);
    expect(deps.searchService.searchPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ spaceId: 'sp-shared' }),
      expect.anything(),
    );
    const out = json(
      await docSearchTool.execute({ query: 'd', space_id: 'Agent Space' }, ctx),
    );
    expect(out.hits.map((h: any) => h.doc_id)).toEqual(['p-agent']);
  });

  it('falls back to any word when no document has them all', async () => {
    const { ctx, deps } = makeCtx();
    deps.searchService.searchPage.mockImplementationOnce(async () => ({
      items: [],
    }));
    const out = json(
      await docSearchTool.execute({ query: 'vent maximal démonstrations' }, ctx),
    );
    expect(deps.searchService.searchPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: 'vent or maximal or démonstrations' }),
      expect.anything(),
    );
    expect(out.match).toBe('any');
    expect(out.hits.length).toBeGreaterThan(0);
  });

  it('keeps match "all" when every word matched', async () => {
    const { ctx, deps } = makeCtx();
    const out = json(await docSearchTool.execute({ query: 'drones notes' }, ctx));
    expect(out.match).toBe('all');
    expect(deps.searchService.searchPage).toHaveBeenCalledTimes(1);
  });

  it('anyWordQuery leaves single words and search syntax alone', () => {
    expect(anyWordQuery('vent')).toBeNull();
    expect(anyWordQuery('"vent fort"')).toBeNull();
    expect(anyWordQuery('a | b')).toBeNull();
    expect(anyWordQuery('vent or pluie')).toBe('vent or pluie');
    expect(anyWordQuery('vent  et pluie')).toBe('vent or et or pluie');
  });

  it('plainExcerpt turns <b> into bold and strips other tags', () => {
    expect(plainExcerpt('a <b>b</b> <i>c</i>\n d')).toBe('a **b** c d');
  });
});

describe('list_folders', () => {
  it('returns each readable space as a tree of pages with folder ids and can_write', async () => {
    const { ctx } = makeCtx();
    const out = json(await listFoldersTool.execute({}, ctx));
    expect(out.spaces.map((s: any) => [s.slug, s.can_write])).toEqual([
      ['agent', true],
      ['shared', false],
    ]);
    const shared = out.spaces[1];
    expect(shared.folders[0]).toMatchObject({
      folder_id: 'p-root',
      title: 'Opportunities',
      child_count: 1,
    });
    expect(shared.folders[0].children[0].folder_id).toBe('p-child');
  });

  it('max_depth cuts children but keeps child_count', () => {
    const { ctx } = makeCtx();
    const tree = buildTree(
      ctx,
      { id: 'sp-shared', name: 'Shared', slug: 'shared', canWrite: false },
      PAGES.slice(0, 2),
      1,
    );
    expect(tree[0].children).toEqual([]);
    expect(tree[0].child_count).toBe(1);
  });

  it('refuses an unshared space', async () => {
    const { ctx } = makeCtx();
    expect(
      (await listFoldersTool.execute({ space_id: 'general' }, ctx)).isError,
    ).toBe(true);
  });
});

describe('markdown helpers', () => {
  it('database marker hook round-trips a node into a marker line', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        { type: 'fakeDatabase', attrs: { id: 'db_1' } },
      ],
    };
    const replaced = replaceDatabaseNodes(doc, new Set(['fakeDatabase']));
    const text = replaced.content[1].content[0].text;
    expect(restoreDatabaseMarkers(`before\n\n${text}\n`)).toBe(
      'before\n\n<!-- database id=db_1 -->\n',
    );
    // The registered type is the S4a block; other node types are left alone.
    expect(replaceDatabaseNodes(doc).content[1]).toEqual(doc.content[1]);
    expect(
      replaceDatabaseNodes({
        type: 'doc',
        content: [{ type: 'droneaidDatabase', attrs: { id: 'db_2' } }],
      }).content[0].content[0].text,
    ).toMatch(/:db_2$/);
    expect(
      restoreDatabaseMarkers(text, new Map([['db_1', '<!-- database id=db_1 "T" -->']])),
    ).toBe('<!-- database id=db_1 "T" -->');
  });

  it('absolutizes root-relative page links only', () => {
    expect(
      absolutizeInternalLinks('[a](/s/x/p/y) [b](https://e.com/s/z)', BASE),
    ).toBe(`[a](${BASE}/s/x/p/y) [b](https://e.com/s/z)`);
  });

  it('builds page URLs like core export and safe link text', () => {
    expect(pageUrl(BASE, 'shared', { slugId: 'abc', title: null })).toBe(
      `${BASE}/s/shared/p/untitled-abc`,
    );
    expect(markdownLink('a [b]', 'u')).toBe('[a b](u)');
  });

  it('matches only the MCP route for the body limit', () => {
    expect(isMcpRoute('/api/droneaid/mcp')).toBe(true);
    expect(isMcpRoute('/api/droneaid/mcp/')).toBe(true);
    expect(isMcpRoute('/api/pages/create')).toBe(false);
  });
});
