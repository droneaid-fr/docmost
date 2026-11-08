import { z } from 'zod';
import { SEARCH_QUERY_MAX_LENGTH } from '../../../core/search/dto/search.dto';
import { defineTool, toolError, toolJson } from './define';
import { scopeSpaces } from './documents';

const DEFAULT_LIMIT = 10;
/** Fetched when doc_ids narrows the result, so the filter still finds hits. */
const NARROWED_FETCH = 100;

export function plainExcerpt(highlight: string | undefined): string {
  return (highlight ?? '')
    .replace(/<b>/gi, '**')
    .replace(/<\/b>/gi, '**')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export const docSearchTool = defineTool({
  name: 'doc_search',
  title: 'Document Search',
  description:
    'Full-text search over the documents you can read (title and body, Postgres full-text, prefix match on the last word). Returns hits with id, title, `[Title](url)` link, space and an excerpt where matches are **bold**. Optionally limit to one space or to given doc ids.',
  access: 'read',
  audience: 'all',
  inputSchema: z
    .object({
      query: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LENGTH),
      space_id: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe('Space id or slug'),
      doc_ids: z.array(z.string().min(1).max(100)).max(50).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    })
    .strict(),
  execute: async ({ query, space_id, doc_ids, limit }, ctx) => {
    const spaces = await scopeSpaces(ctx, space_id);
    if (!spaces) return toolError(`Space ${space_id} not found.`);
    if (spaces.length === 0) {
      return toolJson({ retrieval_mode: 'fulltext', hits: [] });
    }
    const max = limit ?? DEFAULT_LIMIT;

    // SearchService applies the caller's space memberships and page-level
    // restrictions itself; with spaceId set it trusts the caller to have
    // checked the space, which scopeSpaces just did.
    const { items } = await ctx.deps.searchService.searchPage(
      {
        query,
        spaceId: space_id ? spaces[0].id : undefined,
        limit: doc_ids?.length ? NARROWED_FETCH : max,
        offset: 0,
      },
      { userId: ctx.user.id, workspaceId: ctx.workspace.id },
    );

    const wanted = doc_ids?.length ? new Set(doc_ids) : null;
    const bySpace = new Map(spaces.map((s) => [s.id, s]));
    const hits = (items as any[])
      .filter(
        (item) => !wanted || wanted.has(item.id) || wanted.has(item.slugId),
      )
      .filter((item) => bySpace.has(item.space?.id ?? item.spaceId))
      .slice(0, max)
      .map((item) => {
        const space = bySpace.get(item.space?.id ?? item.spaceId);
        return {
          doc_id: item.id,
          title: item.title || 'untitled',
          link: ctx.pageLink(item, space.slug),
          url: ctx.pageUrl(item, space.slug),
          space: space.name,
          excerpt: plainExcerpt(item.highlight),
        };
      });
    return toolJson({ retrieval_mode: 'fulltext', hits });
  },
});
