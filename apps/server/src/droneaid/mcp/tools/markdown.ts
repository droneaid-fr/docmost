import { DATABASE_NODE, findDatabasesInJson } from '@docmost/editor-ext';
import { Page } from '@docmost/db/types/entity.types';
import { getProsemirrorContent } from '../../../common/helpers/prosemirror/utils';
import type { McpToolContext } from './context';

/**
 * Node types rendered as one `<!-- database id=... -->` line instead of their
 * content (the marker the agent's SOUL.md expects from AFFiNE). The data is
 * read and changed with the database tools; update_document keeps the
 * database wherever its marker line stands (keep-blocks.ts).
 */
export const DATABASE_NODE_TYPES: ReadonlySet<string> = new Set<string>([
  DATABASE_NODE,
]);

/** One line of text safe inside the marker comment. */
function inline(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/--+/g, '-')
    .replace(/"/g, "'")
    .replace(/>/g, ')')
    .trim();
}

/** The marker line, as our AFFiNE fork wrote it. */
export function databaseMarker(info: {
  id: string;
  title: string;
  rows: number;
  columns: number;
}): string {
  return `<!-- database id=${info.id} "${inline(info.title) || 'Database'}" (${info.rows} rows, ${info.columns} columns): read it with read_database and edit it with the database tools. update_document keeps it in place. -->`;
}

/** Marker lines for the databases in a ProseMirror doc, by database id. */
export function databaseMarkers(json: any): Map<string, string> {
  const markers = new Map<string, string>();
  for (const db of findDatabasesInJson(json)) {
    if (!db.id || markers.has(db.id)) continue;
    markers.set(
      db.id,
      databaseMarker({
        id: db.id,
        title: db.title,
        rows: db.rows.length,
        columns: db.columns.length,
      }),
    );
  }
  return markers;
}

const MARKER_TOKEN = 'DRONEAIDDBMARKER';
const MARKER_LINE = new RegExp(`^.*${MARKER_TOKEN}:([A-Za-z0-9_-]+).*$`, 'gm');

/**
 * Replaces database nodes with a paragraph that carries a plain-text token.
 * Turndown drops HTML comments, so the comment is restored after conversion
 * (restoreDatabaseMarkers).
 */
export function replaceDatabaseNodes(
  json: any,
  nodeTypes: ReadonlySet<string> = DATABASE_NODE_TYPES,
): any {
  if (!json || typeof json !== 'object' || nodeTypes.size === 0) return json;
  const visit = (node: any): any => {
    if (!node || typeof node !== 'object') return node;
    if (nodeTypes.has(node.type)) {
      const id = String(node.attrs?.id ?? 'unknown').replace(
        /[^A-Za-z0-9_-]/g,
        '',
      );
      return {
        type: 'paragraph',
        content: [{ type: 'text', text: `${MARKER_TOKEN}:${id || 'unknown'}` }],
      };
    }
    return Array.isArray(node.content)
      ? { ...node, content: node.content.map(visit) }
      : node;
  };
  return visit(json);
}

export function restoreDatabaseMarkers(
  markdown: string,
  markers: ReadonlyMap<string, string> = new Map(),
): string {
  return markdown.replace(
    MARKER_LINE,
    (_line, id) => markers.get(id) ?? `<!-- database id=${id} -->`,
  );
}

/** Root-relative page links (`/s/...`, `/p/...`) become absolute URLs. */
export function absolutizeInternalLinks(
  markdown: string,
  baseUrl: string,
): string {
  return markdown.replace(/\]\((\/(?:s|p)\/[^)\s]+)\)/g, `](${baseUrl}$1)`);
}

/**
 * Markdown of a page through core's own export path
 * (ExportService.turnPageMentionsToLinks + exportPage): the title as H1,
 * page mentions as `[Title](<page URL>)` links, filtered by the caller's
 * access exactly as a user's own export is.
 */
export async function pageToMarkdown(
  ctx: McpToolContext,
  page: Page,
): Promise<string> {
  const exportService = ctx.deps.exportService;
  const base = ctx.baseUrl;
  const json = getProsemirrorContent(page.content);
  const markers = databaseMarkers(json);
  const withMarkers = replaceDatabaseNodes(json);
  const content = await exportService.turnPageMentionsToLinks(
    withMarkers,
    ctx.workspace.id,
    base,
    ctx.user.id,
  );
  const markdown = (await exportService.exportPage('markdown', {
    ...page,
    content,
  })) as string;
  return absolutizeInternalLinks(
    restoreDatabaseMarkers(markdown ?? '', markers),
    base,
  );
}
