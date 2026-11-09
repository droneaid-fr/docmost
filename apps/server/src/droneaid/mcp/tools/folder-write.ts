import { sql } from 'kysely';
import { z } from 'zod';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { Page } from '@docmost/db/types/entity.types';
import { CreatePageDto } from '../../../core/page/dto/create-page.dto';
import { UpdatePageDto } from '../../../core/page/dto/update-page.dto';
import type { McpToolContext } from './context';
import {
  defineTool,
  docNotFound,
  errorMessage,
  McpTool,
  McpToolResult,
  toolError,
  toolJson,
} from './define';
import {
  cleanTitle,
  editablePage,
  isRefusal,
  notifyTree,
  resolveCreateTarget,
} from './write-access';

/**
 * Docmost has no folders: a "folder" is a page with child pages (see
 * list_folders). How the AFFiNE folder tools map onto the page tree:
 *  - create_folder creates an empty page;
 *  - rename_folder renames that page;
 *  - move_folder_item moves a page (and its children) under another page or
 *    to the top level, also into another space you can write;
 *  - add_to_folder moves the document under the folder: a page has exactly
 *    one place, unlike an AFFiNE doc, which could sit in several folders;
 *  - remove_from_folder moves the document to the top level of its space.
 * Item, link and folder ids are all page ids. Nothing is ever deleted.
 */

const ID = z.string().min(1).max(100);
const NAME = z.string().min(1).max(255);

async function siblingPosition(
  ctx: McpToolContext,
  spaceId: string,
  parentId: string | null,
  where: 'first' | 'last',
  excludeId: string,
): Promise<string> {
  const edge = await ctx.deps.db
    .selectFrom('pages')
    .select('position')
    .where('spaceId', '=', spaceId)
    .where('deletedAt', 'is', null)
    .where('id', '!=', excludeId)
    .$if(parentId === null, (qb) => qb.where('parentPageId', 'is', null))
    .$if(parentId !== null, (qb) => qb.where('parentPageId', '=', parentId))
    .orderBy(sql`position collate "C"`, where === 'first' ? 'asc' : 'desc')
    .limit(1)
    .executeTakeFirst();
  const position = edge?.position ?? null;
  return where === 'first'
    ? generateJitteredKeyBetween(null, position)
    : generateJitteredKeyBetween(position, null);
}

type MoveResult = {
  itemId: string;
  parentId: string | null;
  spaceId: string;
};

/**
 * Moves a page the caller can edit, checked like core's /pages/move and
 * /pages/move-to-space: edit rights on the page, on the new parent, and on
 * pages in both spaces for a move between spaces.
 */
export async function movePage(
  ctx: McpToolContext,
  opts: {
    itemId: string;
    parentId?: string | null;
    spaceId?: string;
    position?: 'first' | 'last';
  },
): Promise<MoveResult | { refused: McpToolResult }> {
  const page = await editablePage(ctx, opts.itemId);
  if (isRefusal(page)) return page;

  let parent: Page | null = null;
  if (opts.parentId) {
    if (opts.parentId === page.id || opts.parentId === page.slugId) {
      return { refused: toolError('A page cannot be moved under itself.') };
    }
    parent = await ctx.findReadablePage(opts.parentId);
    if (!parent) return { refused: docNotFound(opts.parentId) };
    if (!(await ctx.canEditPage(parent))) {
      return {
        refused: toolError(
          `You cannot add documents under ${opts.parentId}: you only have read access to it.`,
        ),
      };
    }
  }

  const fromSpace = await ctx.readableSpace(page.spaceId);
  const toSpace = parent
    ? await ctx.readableSpace(parent.spaceId)
    : opts.spaceId
      ? await ctx.readableSpace(opts.spaceId)
      : fromSpace;
  if (!toSpace) return { refused: toolError(`Space ${opts.spaceId} not found.`) };
  if (parent && opts.spaceId && ![toSpace.id, toSpace.slug].includes(opts.spaceId)) {
    return {
      refused: toolError(
        `Folder ${opts.parentId} is in space "${toSpace.name}", not ${opts.spaceId}.`,
      ),
    };
  }

  let current = page;
  if (toSpace.id !== page.spaceId) {
    if (!fromSpace?.canWrite || !toSpace.canWrite) {
      return {
        refused: toolError(
          `You cannot move documents into space "${toSpace.name}": you only have read access there.`,
        ),
      };
    }
    await ctx.deps.pageService.movePageToSpace(page, toSpace.id, ctx.user.id);
    current = await ctx.deps.pageRepo.findById(page.id);
    await notifyTree(ctx, page, 'structure');
  }

  const parentId = parent?.id ?? null;
  const position = await siblingPosition(
    ctx,
    toSpace.id,
    parentId,
    opts.position ?? 'last',
    current.id,
  );
  await ctx.deps.pageService.movePage(
    { pageId: current.id, parentPageId: parentId, position },
    current,
  );
  await notifyTree(ctx, current, 'structure');
  return { itemId: current.id, parentId, spaceId: toSpace.id };
}

export const createFolderTool = defineTool({
  name: 'create_folder',
  title: 'Create Folder',
  description:
    'Create a folder: in Docmost an (empty) page that other documents are filed under. At the top of your own space, of space_id, or inside parent_id. Returns its folderId (a page id; use it as folder_id / parent_id). If a page with the same name already exists at that level it is returned instead.',
  access: 'write',
  audience: 'all',
  inputSchema: z
    .object({
      name: NAME,
      parent_id: ID.optional().describe('Parent folder (page) id'),
      space_id: ID.optional().describe('Space id, slug or name; default: your own space'),
    })
    .strict(),
  execute: async ({ name, parent_id, space_id }, ctx) => {
    const folderName = cleanTitle(name);
    if (!folderName) return toolError('Folder name is empty.');
    const target = await resolveCreateTarget(ctx, {
      spaceId: space_id,
      parentId: parent_id,
    });
    if (isRefusal(target)) return target.refused;
    try {
      const existing = await ctx.deps.db
        .selectFrom('pages')
        .select(['id'])
        .where('spaceId', '=', target.space.id)
        .where('deletedAt', 'is', null)
        .where('title', '=', folderName)
        .$if(!target.parent, (qb) => qb.where('parentPageId', 'is', null))
        .$if(!!target.parent, (qb) =>
          qb.where('parentPageId', '=', target.parent.id),
        )
        .execute();
      const visible = await ctx.filterAccessiblePageIds(
        existing.map((row) => row.id),
      );
      if (visible.length) {
        return toolJson({
          success: true,
          folderId: visible[0],
          id: visible[0],
          created: false,
        });
      }
      const page = await ctx.deps.pageService.create(
        ctx.user.id,
        ctx.workspace.id,
        {
          title: folderName,
          spaceId: target.space.id,
          parentPageId: target.parent?.id,
        } as CreatePageDto,
      );
      await notifyTree(ctx, page, 'structure');
      return toolJson({
        success: true,
        folderId: page.id,
        id: page.id,
        created: true,
        link: ctx.pageLink(page, target.space.slug),
      });
    } catch (error) {
      return toolError(`Failed to create folder: ${errorMessage(error)}`);
    }
  },
});

export const renameFolderTool = defineTool({
  name: 'rename_folder',
  title: 'Rename Folder',
  description: 'Rename a folder (the title of the page with that id).',
  access: 'write',
  audience: 'all',
  inputSchema: z.object({ folder_id: ID, name: NAME }).strict(),
  execute: async ({ folder_id, name }, ctx) => {
    const folderName = cleanTitle(name);
    if (!folderName) return toolError('Folder name is empty.');
    const page = await editablePage(ctx, folder_id);
    if (isRefusal(page)) return page.refused;
    try {
      const updated = await ctx.deps.pageService.update(
        page,
        { pageId: page.id, title: folderName } as UpdatePageDto,
        ctx.user,
      );
      await notifyTree(ctx, updated, 'meta');
      return toolJson({ success: true, folderId: page.id });
    } catch (error) {
      return toolError(`Failed to rename folder: ${errorMessage(error)}`);
    }
  },
});

export const moveFolderItemTool = defineTool({
  name: 'move_folder_item',
  title: 'Move Folder Item',
  description:
    'Move a document or folder (a page, with everything under it) into another folder (parent_id), or to the top level of its space (parent_id omitted), or of space_id to move it into another space you can write. position: "first" or "last" (default) among its new siblings. item_id is the page id.',
  access: 'write',
  audience: 'all',
  inputSchema: z
    .object({
      item_id: ID.describe('Page id of the document or folder'),
      parent_id: ID.optional().describe('Target folder (page) id'),
      space_id: ID.optional().describe('Target space id or slug'),
      position: z.enum(['first', 'last']).optional(),
    })
    .strict(),
  execute: async ({ item_id, parent_id, space_id, position }, ctx) => {
    try {
      const result = await movePage(ctx, {
        itemId: item_id,
        parentId: parent_id,
        spaceId: space_id,
        position,
      });
      if (isRefusal(result)) return result.refused;
      return toolJson({ success: true, ...result });
    } catch (error) {
      return toolError(`Failed to move item: ${errorMessage(error)}`);
    }
  },
});

export const addToFolderTool = defineTool({
  name: 'add_to_folder',
  title: 'Add To Folder',
  description:
    'File a document into a folder. A Docmost page lives in exactly one place, so this MOVES the document (with its sub-pages) under the folder, out of wherever it was. Only documents (type "doc") can be filed. Returns linkId = the document id.',
  access: 'write',
  audience: 'all',
  inputSchema: z
    .object({
      folder_id: ID,
      target_id: ID.describe('Document (page) id'),
      type: z.enum(['doc', 'tag', 'collection']).optional(),
    })
    .strict(),
  execute: async ({ folder_id, target_id, type = 'doc' }, ctx) => {
    if (type !== 'doc') {
      return toolError('Only documents can be filed into folders here.');
    }
    try {
      const result = await movePage(ctx, {
        itemId: target_id,
        parentId: folder_id,
      });
      if (isRefusal(result)) return result.refused;
      return toolJson({
        success: true,
        linkId: result.itemId,
        moved: true,
        ...result,
      });
    } catch (error) {
      return toolError(`Failed to add to folder: ${errorMessage(error)}`);
    }
  },
});

export const removeFromFolderTool = defineTool({
  name: 'remove_from_folder',
  title: 'Remove From Folder',
  description:
    'Take a document out of its folder: it moves to the top level of its space (a page always has a place). The document itself is untouched. link_id is the document id.',
  access: 'write',
  audience: 'all',
  inputSchema: z.object({ link_id: ID }).strict(),
  execute: async ({ link_id }, ctx) => {
    try {
      const result = await movePage(ctx, { itemId: link_id, parentId: null });
      if (isRefusal(result)) return result.refused;
      return toolJson({ success: true, linkId: result.itemId, ...result });
    } catch (error) {
      return toolError(`Failed to remove from folder: ${errorMessage(error)}`);
    }
  },
});

export const folderWriteTools: McpTool<any>[] = [
  createFolderTool,
  renameFolderTool,
  moveFolderItemTool,
  addToFolderTool,
  removeFromFolderTool,
];
