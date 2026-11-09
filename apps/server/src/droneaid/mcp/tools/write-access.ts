import { Logger } from '@nestjs/common';
import { Page } from '@docmost/db/types/entity.types';
import type { McpToolContext, ReadableSpace } from './context';
import { docNotFound, McpToolResult, toolError } from './define';

/**
 * Permission and placement checks shared by the write tools. Every decision
 * is core's: PageAccessService.validateCanEdit / validateCanCreate (via
 * McpToolContext) and the space ability. An agent writes in its own space
 * (writer) and wherever an admin made it a writer; it is never a member of
 * "Everyone", so it cannot write in General.
 */

const logger = new Logger('DroneaidMcpWrite');

export type Refusal = { refused: McpToolResult };

export const isRefusal = (value: unknown): value is Refusal =>
  !!value && typeof value === 'object' && 'refused' in value;

/** A title or folder name: one line, trimmed, at most 255 characters. */
export function cleanTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 255);
}

/** The page if the caller may edit it; otherwise why not. */
export async function editablePage(
  ctx: McpToolContext,
  docId: string,
): Promise<Page | Refusal> {
  const page = await ctx.findReadablePage(docId);
  if (!page) return { refused: docNotFound(docId) };
  if (!(await ctx.canEditPage(page))) {
    return {
      refused: toolError(
        `You cannot edit document ${docId}: you only have read access to it.`,
      ),
    };
  }
  return page;
}

export type CreateTarget = { space: ReadableSpace; parent: Page | null };

/**
 * Where a new page goes: under `parentId` (a "folder"), else at the top of
 * `spaceId`, else at the top of the agent's own space. Checked like core's
 * POST /pages/create: edit rights on the parent, or create rights in the
 * space for a top-level page.
 */
export async function resolveCreateTarget(
  ctx: McpToolContext,
  opts: { spaceId?: string; parentId?: string },
): Promise<CreateTarget | Refusal> {
  if (opts.parentId) {
    const parent = await ctx.findReadablePage(opts.parentId);
    if (!parent) return { refused: docNotFound(opts.parentId) };
    const space = await ctx.readableSpace(parent.spaceId);
    if (!space) return { refused: docNotFound(opts.parentId) };
    if (opts.spaceId && opts.spaceId !== space.id && opts.spaceId !== space.slug) {
      return {
        refused: toolError(
          `Folder ${opts.parentId} is in space "${space.name}", not ${opts.spaceId}.`,
        ),
      };
    }
    if (!(await ctx.canEditPage(parent))) {
      return {
        refused: toolError(
          `You cannot add documents under ${opts.parentId}: you only have read access to it.`,
        ),
      };
    }
    return { space, parent };
  }

  const spaceKey = opts.spaceId ?? ctx.principal.agentSpaceId ?? undefined;
  if (!spaceKey) {
    return {
      refused: toolError(
        'Pass folder_id or space_id (see list_folders for where you can write).',
      ),
    };
  }
  const space = await ctx.readableSpace(spaceKey);
  if (!space) return { refused: toolError(`Space ${spaceKey} not found.`) };
  if (!(await ctx.canCreateInSpace(space.id))) {
    return {
      refused: toolError(
        `You cannot create documents in space "${space.name}": you only have read access there.`,
      ),
    };
  }
  return { space, parent: null };
}

/**
 * Tells open sidebars of the space that its tree changed. Title changes go
 * out as `updateOne` (as the client's own rename does) unless the space has
 * restricted pages, where only a content-free refetch is sent, so no title
 * reaches someone who may not see the page.
 */
export async function notifyTree(
  ctx: McpToolContext,
  page: Pick<Page, 'id' | 'slugId' | 'spaceId' | 'parentPageId'> & {
    title?: string | null;
    icon?: string | null;
  },
  change: 'structure' | 'meta',
) {
  try {
    const restricted =
      await ctx.deps.pagePermissionRepo.hasRestrictedPagesInSpace(page.spaceId);
    const event =
      change === 'meta' && !restricted
        ? {
            operation: 'updateOne',
            spaceId: page.spaceId,
            entity: ['pages'],
            id: page.id,
            payload: {
              slugId: page.slugId,
              parentPageId: page.parentPageId ?? null,
              ...(page.title !== undefined ? { title: page.title } : {}),
              ...(page.icon !== undefined ? { icon: page.icon } : {}),
            },
          }
        : { operation: 'refetchRootTreeNodeEvent', spaceId: page.spaceId };
    await ctx.deps.wsService.emitToSpaceExceptUsers(page.spaceId, [], event);
  } catch (error) {
    logger.warn(`Tree notification failed: ${(error as Error)?.message}`);
  }
}
