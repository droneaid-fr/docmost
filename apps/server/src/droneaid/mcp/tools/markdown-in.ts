import { load } from 'cheerio';
import slugify from '@sindresorhus/slugify';
import { v7 as uuid7, validate as isUuid } from 'uuid';
import { markdownToHtml } from '@docmost/editor-ext';
import {
  htmlToJson,
  jsonToNode,
} from '../../../collaboration/collaboration.util';
import type { McpToolContext } from './context';
import { QueueJob } from '../../../integrations/queue/constants';
import {
  extractInternalLinkSlugIds,
  extractMentions,
  extractPageMentions,
} from '../../../common/helpers/prosemirror/utils';
import { normalizeUrl, scanMarkers } from './keep-blocks';

/**
 * Markdown from an MCP caller -> ProseMirror JSON, through core's own
 * converters (markdownToHtml, htmlToJson), with two rewrites on the HTML in
 * between, done the way core's ZIP import does them
 * (import-formatter.ts rewriteInternalLinksToMentionHtml):
 *  - a link to a page the caller can read becomes a page mention when its
 *    text is the page title, otherwise an internal link;
 *  - an image pointing at an uploaded file (`blob://<id>` from upload_image,
 *    or `/api/files/<id>/...`) gets the file URL and attachment id the editor
 *    expects.
 */

export type LinkedPage = { docId: string; title: string };

export type ParsedMarkdown = {
  json: any;
  /** Attachments the Markdown references (to attach to the page). */
  attachmentIds: string[];
  linkedPages: LinkedPage[];
  warnings: string[];
  /** Text sent between a kept container's start and end markers, by key. */
  regions: Map<string, string>;
};

const norm = (text: string | null | undefined) =>
  (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Drops a leading `# Title` when it repeats the page title. */
export function stripLeadingTitle(
  markdown: string,
  title: string | null | undefined,
): string {
  const match = /^\s*#[ \t]+([^\n]*?)[ \t#]*(?:\n|$)/.exec(markdown);
  if (!match || !title || norm(match[1]) !== norm(title)) return markdown;
  return markdown.slice(match[0].length);
}

/**
 * The page id or slug id a link points at, for links to this workspace:
 * `<base>/s/<space>/p/<slug>-<slugId>`, `/p/<slug>-<slugId>` (absolute or
 * root-relative), or the id forms `affine://<id>` / `docmost://<id>`.
 */
export function pageRefFromHref(href: string, baseUrl: string): string | null {
  const idLink = /^(?:affine|docmost):\/\/([A-Za-z0-9_-]+)\/?$/.exec(
    href.trim(),
  );
  if (idLink) return idLink[1];
  const path = normalizeUrl(href, baseUrl);
  if (!path?.startsWith('/')) return null;
  const match = /^\/(?:s\/[^/]+\/)?p\/([^/]+)\/?$/.exec(path);
  if (!match) return null;
  const slug = match[1];
  return slug.split('-').pop() || null;
}

/** `blob://<id>` or `/api/files/<id>/<name>` (ours) -> attachment id. */
export function attachmentRefFromSrc(
  src: string,
  baseUrl: string,
): { id: string; blob: boolean } | null {
  const blob = /^blob:\/\/([0-9a-fA-F-]{36})\/?$/.exec(src.trim());
  if (blob) return { id: blob[1].toLowerCase(), blob: true };
  const path = normalizeUrl(src, baseUrl);
  const file = path && /^(?:\/api)?\/files\/([0-9a-fA-F-]{36})(?:\/|$)/.exec(path);
  return file ? { id: file[1].toLowerCase(), blob: false } : null;
}

export function fileUrl(attachment: { id: string; fileName: string }) {
  return `/api/files/${attachment.id}/${encodeURIComponent(attachment.fileName)}`;
}

export async function markdownToDoc(
  ctx: McpToolContext,
  markdown: string,
  opts: { title?: string | null } = {},
): Promise<ParsedMarkdown> {
  const scanned = scanMarkers(stripLeadingTitle(markdown ?? '', opts.title));
  const html = await markdownToHtml(scanned.markdown);
  const $ = load(html, null, false);
  const baseUrl = ctx.baseUrl;
  const warnings: string[] = [];
  const linked = new Map<string, LinkedPage>();
  const attachmentIds = new Set<string>();
  const spaceSlugs = new Map<string, string>();

  const spaceSlug = async (spaceId: string) => {
    if (!spaceSlugs.has(spaceId)) {
      const space = await ctx.deps.spaceRepo.findById(
        spaceId,
        ctx.workspace.id,
      );
      spaceSlugs.set(spaceId, space?.slug ?? '');
    }
    return spaceSlugs.get(spaceId);
  };

  for (const el of $('a[href]').toArray()) {
    const $a = $(el);
    const ref = pageRefFromHref($a.attr('href') ?? '', baseUrl);
    if (!ref) continue;
    // Only pages the caller may read, so links cannot probe for others.
    const page = await ctx.findReadablePage(ref);
    if (!page) continue;
    const title = page.title || 'untitled';
    linked.set(page.id, { docId: page.id, title });
    if (norm($a.text()) === norm(title)) {
      const mention = $('<span>')
        .attr({
          'data-type': 'mention',
          'data-id': uuid7(),
          'data-entity-type': 'page',
          'data-entity-id': page.id,
          'data-label': title,
          'data-slug-id': page.slugId,
          'data-creator-id': ctx.user.id,
        })
        .text(title);
      $a.replaceWith(mention);
    } else {
      const slug = `${slugify(title.substring(0, 70))}-${page.slugId}`;
      const space = await spaceSlug(page.spaceId);
      $a.attr('href', space ? `/s/${space}/p/${slug}` : `/p/${slug}`);
      $a.attr('data-internal', 'true');
    }
  }

  for (const el of $('img[src]').toArray()) {
    const $img = $(el);
    const src = $img.attr('src') ?? '';
    const ref = attachmentRefFromSrc(src, baseUrl);
    if (!ref) continue;
    const attachment = isUuid(ref.id)
      ? await ctx.deps.attachmentRepo.findById(ref.id)
      : null;
    if (!attachment || attachment.workspaceId !== ctx.workspace.id) {
      if (ref.blob) {
        warnings.push(`Image ${src} not found; upload it with upload_image.`);
        $img.remove();
      }
      continue;
    }
    $img.attr('src', fileUrl(attachment));
    $img.attr('data-attachment-id', attachment.id);
    attachmentIds.add(attachment.id);
  }

  // An image alone on its line is a block in Docmost; unwrapped here, or the
  // schema lifts it out of its <p> and leaves an empty paragraph behind.
  for (const el of $('p').toArray()) {
    const $p = $(el);
    const kids = $p.contents().toArray();
    const meaningful = kids.filter(
      (k: any) => !(k.type === 'text' && !k.data?.trim()) && k.name !== 'br',
    );
    if (meaningful.length && meaningful.every((k: any) => k.name === 'img')) {
      $p.replaceWith(meaningful);
    }
  }

  const json = htmlToJson($.html());
  jsonToNode(json); // throws on content the schema cannot hold
  return {
    json,
    attachmentIds: [...attachmentIds],
    linkedPages: [...linked.values()],
    warnings,
    regions: scanned.regions,
  };
}

/**
 * Files the caller uploaded with upload_image and has not used yet are
 * attached to the page that now shows them, so core serves them to anyone
 * who can view that page. Files already on a page are left where they are.
 */
export async function claimAttachments(
  ctx: McpToolContext,
  attachmentIds: string[],
  page: { id: string; spaceId: string },
): Promise<number> {
  if (!attachmentIds.length) return 0;
  const result = await ctx.deps.db
    .updateTable('attachments')
    .set({ pageId: page.id, spaceId: page.spaceId, updatedAt: new Date() })
    .where('id', 'in', attachmentIds)
    .where('workspaceId', '=', ctx.workspace.id)
    .where('creatorId', '=', ctx.user.id)
    .where('pageId', 'is', null)
    .executeTakeFirst();
  return Number(result?.numUpdatedRows ?? 0);
}

/**
 * Queues core's backlink job for a page created with content. Edits through
 * the collaboration server get it from the history processor; a page created
 * straight from JSON (PageService.create) does not, so we queue it here.
 */
export async function queueBacklinks(
  ctx: McpToolContext,
  page: { id: string; workspaceId: string },
  json: any,
) {
  try {
    await ctx.deps.generalQueue.add(QueueJob.PAGE_BACKLINKS, {
      pageId: page.id,
      workspaceId: page.workspaceId,
      mentions: extractPageMentions(extractMentions(json)),
      internalLinkSlugIds: extractInternalLinkSlugIds(json),
    });
  } catch {
    // Backlinks are rebuilt on the next edit of the page.
  }
}
