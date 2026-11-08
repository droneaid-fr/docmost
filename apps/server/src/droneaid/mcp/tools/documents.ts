import { z } from 'zod';
import { McpToolContext, ReadableSpace } from './context';
import {
  defineTool,
  docNotFound,
  errorMessage,
  McpTool,
  toolError,
  toolJson,
  toolText,
} from './define';
import { pageToMarkdown } from './markdown';

const DOC_ID = z
  .string()
  .min(1)
  .max(100)
  .describe(
    'Page id (UUID) or its short slug id, as returned by the other tools',
  );

const iso = (value: Date | string | null | undefined) =>
  value ? new Date(value).toISOString() : undefined;

export const readDocumentTool = defineTool({
  name: 'read_document',
  title: 'Read Document',
  description:
    'Read a document as markdown (title as the first heading). Links to other pages are rendered as `[Title](<page URL>)`. A database shows as one `<!-- database id=... -->` line.',
  access: 'read',
  audience: 'all',
  inputSchema: z.object({ docId: DOC_ID }).strict(),
  execute: async ({ docId }, ctx) => {
    const page = await ctx.findReadablePage(docId, { includeContent: true });
    if (!page) return docNotFound(docId);
    try {
      return toolText(await pageToMarkdown(ctx, page));
    } catch (error) {
      return toolError(`Failed to read document: ${errorMessage(error)}`);
    }
  },
});

export const listDocumentsTool = defineTool({
  name: 'list_documents',
  title: 'List Documents',
  description:
    'List documents you can read, most recently updated first, with id, title, `[Title](url)` link, space, parent and dates. Filter by space (id or slug), by parent document (its direct children; use "root" with space_id for top-level pages) or by a title substring. Paged with limit/offset.',
  access: 'read',
  audience: 'all',
  inputSchema: z
    .object({
      space_id: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe('Space id or slug'),
      parent_id: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe(
          'Only direct children of this document, or "root" for top-level pages',
        ),
      title_contains: z.string().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).optional(),
    })
    .strict(),
  execute: async (args, ctx) => {
    const spaces = await scopeSpaces(ctx, args.space_id);
    if (!spaces) return toolError(`Space ${args.space_id} not found.`);

    let parentId: string | null | undefined;
    if (args.parent_id === 'root') {
      if (!args.space_id) {
        return toolError('parent_id "root" needs space_id.');
      }
      parentId = null;
    } else if (args.parent_id) {
      const parent = await ctx.findReadablePage(args.parent_id);
      if (!parent || !spaces.some((s) => s.id === parent.spaceId)) {
        return docNotFound(args.parent_id);
      }
      parentId = parent.id;
    }

    const offset = args.offset ?? 0;
    const limit = args.limit ?? 100;
    const { total, rows } = await queryPages(ctx, {
      spaceIds: spaces.map((s) => s.id),
      parentId,
      titleContains: args.title_contains,
      limit,
      offset,
    });
    const slugById = new Map(spaces.map((s) => [s.id, s]));
    return toolJson({
      total,
      offset,
      documents: rows.map((row) => {
        const space = slugById.get(row.spaceId);
        const url = ctx.pageUrl(row, space.slug);
        return {
          id: row.id,
          slugId: row.slugId,
          title: row.title || 'untitled',
          link: ctx.pageLink(row, space.slug),
          url,
          spaceId: row.spaceId,
          space: space.name,
          parentId: row.parentPageId ?? null,
          createdAt: iso(row.createdAt),
          updatedAt: iso(row.updatedAt),
        };
      }),
    });
  },
});

export const getDocumentInfoTool = defineTool({
  name: 'get_document_info',
  title: 'Get Document Info',
  description:
    'Metadata of one document: title, ids, `[Title](url)` link, space, parent, the path of parent documents it sits under, creator, last editor, dates, and whether you can edit it.',
  access: 'read',
  audience: 'all',
  inputSchema: z.object({ docId: DOC_ID }).strict(),
  execute: async ({ docId }, ctx) => {
    const found = await ctx.findReadablePage(docId);
    if (!found) return docNotFound(docId);
    const page = await ctx.deps.pageRepo.findById(found.id, {
      includeSpace: true,
      includeCreator: true,
      includeLastUpdatedBy: true,
    });
    const space = (page as any).space as {
      id: string;
      name: string;
      slug: string;
    };
    const crumbs = await ctx.deps.pageService.getPageBreadCrumbs(page.id);
    const ancestors = crumbs.filter((c: any) => c.id !== page.id);
    const parent = ancestors[ancestors.length - 1];
    const creator = (page as any).creator;
    const editor = (page as any).lastUpdatedBy;

    return toolJson({
      id: page.id,
      slugId: page.slugId,
      title: page.title || 'untitled',
      link: ctx.pageLink(page, space.slug),
      url: ctx.pageUrl(page, space.slug),
      space: { id: space.id, name: space.name, slug: space.slug },
      parent: parent
        ? {
            id: parent.id,
            title: parent.title || 'untitled',
            link: ctx.pageLink(parent as any, space.slug),
          }
        : null,
      path: ancestors.map((c: any) => c.title || 'untitled'),
      createdBy: creator ? { id: creator.id, name: creator.name } : null,
      updatedBy: editor ? { id: editor.id, name: editor.name } : null,
      createdAt: iso(page.createdAt),
      updatedAt: iso(page.updatedAt),
      canEdit: await ctx.canEditPage(page),
    });
  },
});

/** All readable spaces, or the one named; null when it is not readable. */
export async function scopeSpaces(
  ctx: McpToolContext,
  spaceIdOrSlug?: string,
): Promise<ReadableSpace[] | null> {
  if (!spaceIdOrSlug) return ctx.readableSpaces();
  const space = await ctx.readableSpace(spaceIdOrSlug);
  return space ? [space] : null;
}

type PageRow = {
  id: string;
  slugId: string;
  title: string | null;
  spaceId: string;
  parentPageId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

async function queryPages(
  ctx: McpToolContext,
  opts: {
    spaceIds: string[];
    parentId?: string | null;
    titleContains?: string;
    limit: number;
    offset: number;
  },
): Promise<{ total: number; rows: PageRow[] }> {
  if (opts.spaceIds.length === 0) return { total: 0, rows: [] };
  const base = ctx.deps.db
    .selectFrom('pages')
    .where('workspaceId', '=', ctx.workspace.id)
    .where('spaceId', 'in', opts.spaceIds)
    .where('deletedAt', 'is', null)
    .$if(opts.parentId === null, (qb) => qb.where('parentPageId', 'is', null))
    .$if(!!opts.parentId, (qb) => qb.where('parentPageId', '=', opts.parentId))
    .$if(!!opts.titleContains, (qb) =>
      qb.where('title', 'ilike', `%${escapeLike(opts.titleContains)}%`),
    );

  const candidates = await base
    .select([
      'id',
      'slugId',
      'title',
      'spaceId',
      'parentPageId',
      'createdAt',
      'updatedAt',
    ])
    .orderBy('updatedAt', 'desc')
    .orderBy('id', 'asc')
    .execute();

  // Page-level restrictions are applied to the whole candidate set so that
  // total and paging agree with what the caller can actually open.
  const visible = new Set(
    await ctx.filterAccessiblePageIds(candidates.map((row) => row.id)),
  );
  const rows = candidates.filter((row) => visible.has(row.id));
  return {
    total: rows.length,
    rows: rows.slice(opts.offset, opts.offset + opts.limit),
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export const documentTools: McpTool<any>[] = [
  readDocumentTool,
  listDocumentsTool,
  getDocumentInfoTool,
];
