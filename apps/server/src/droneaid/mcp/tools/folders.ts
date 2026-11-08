import { sql } from 'kysely';
import { z } from 'zod';
import { McpToolContext, ReadableSpace } from './context';
import { defineTool, toolError, toolJson } from './define';
import { scopeSpaces } from './documents';
import { spaceUrl } from './page-url';

/** Upper bound on pages returned per call, so one huge space cannot flood the reply. */
export const MAX_TREE_PAGES = 2000;

type TreeRow = {
  id: string;
  slugId: string;
  title: string | null;
  parentPageId: string | null;
  spaceId: string;
};

export type FolderNode = {
  folder_id: string;
  title: string;
  link: string;
  child_count: number;
  children: FolderNode[];
};

/**
 * Docmost has no folders: any page can hold child pages. The tree below is
 * the sidebar page tree; a document is filed "in a folder" by creating it
 * with that page as its parent, so `folder_id` is a parent page id.
 */
export const listFoldersTool = defineTool({
  name: 'list_folders',
  title: 'List Folders',
  description:
    'The page tree of each space you can read, in sidebar order. Docmost has no separate folders: every page can contain child pages, so a "folder" is a page and its folder_id is the page id to pass as parent (create_document folder_id, list_documents parent_id). can_write tells you where you may file new documents. Optional: space_id (id or slug) and max_depth (1 = top-level pages only).',
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
      max_depth: z.number().int().min(1).max(50).optional(),
    })
    .strict(),
  execute: async ({ space_id, max_depth }, ctx) => {
    const spaces = await scopeSpaces(ctx, space_id);
    if (!spaces) return toolError(`Space ${space_id} not found.`);

    const rows = await loadTreeRows(ctx, spaces);
    const truncated = rows.length > MAX_TREE_PAGES;
    const kept = truncated ? rows.slice(0, MAX_TREE_PAGES) : rows;

    return toolJson({
      spaces: spaces.map((space) => ({
        space_id: space.id,
        name: space.name,
        slug: space.slug,
        url: spaceUrl(ctx.baseUrl, space.slug),
        can_write: space.canWrite,
        folders: buildTree(
          ctx,
          space,
          kept.filter((row) => row.spaceId === space.id),
          max_depth,
        ),
      })),
      ...(truncated
        ? {
            truncated: true,
            note: `Only the first ${MAX_TREE_PAGES} pages are shown; pass space_id or max_depth.`,
          }
        : {}),
    });
  },
});

async function loadTreeRows(
  ctx: McpToolContext,
  spaces: ReadableSpace[],
): Promise<TreeRow[]> {
  if (spaces.length === 0) return [];
  const rows = await ctx.deps.db
    .selectFrom('pages')
    .select(['id', 'slugId', 'title', 'parentPageId', 'spaceId'])
    .where('workspaceId', '=', ctx.workspace.id)
    .where(
      'spaceId',
      'in',
      spaces.map((s) => s.id),
    )
    .where('deletedAt', 'is', null)
    // Same order as the sidebar (PageService.getSidebarPages).
    .orderBy(sql`position collate "C"`, 'asc')
    .orderBy('id', 'asc')
    .execute();
  const visible = new Set(
    await ctx.filterAccessiblePageIds(rows.map((row) => row.id)),
  );
  return rows.filter((row) => visible.has(row.id));
}

export function buildTree(
  ctx: McpToolContext,
  space: ReadableSpace,
  rows: TreeRow[],
  maxDepth?: number,
): FolderNode[] {
  const byParent = new Map<string | null, TreeRow[]>();
  const ids = new Set(rows.map((row) => row.id));
  for (const row of rows) {
    // A page whose parent is hidden or trashed is shown at the top level.
    const parent =
      row.parentPageId && ids.has(row.parentPageId) ? row.parentPageId : null;
    const siblings = byParent.get(parent) ?? [];
    byParent.set(parent, [...siblings, row]);
  }
  const build = (parentId: string | null, depth: number): FolderNode[] =>
    (byParent.get(parentId) ?? []).map((row) => ({
      folder_id: row.id,
      title: row.title || 'untitled',
      link: ctx.pageLink(row, space.slug),
      child_count: byParent.get(row.id)?.length ?? 0,
      children: maxDepth && depth >= maxDepth ? [] : build(row.id, depth + 1),
    }));
  return build(null, 1);
}
