import { DatabaseData, databaseToJson } from '@docmost/editor-ext';
import { jsonToNode } from '../../collaboration/collaboration.util';
import { fileUrl, markdownToDoc } from '../mcp/tools/markdown-in';
import { KEEP_TOKEN } from '../mcp/tools/keep-blocks';
import type { McpToolContext } from '../mcp/tools/context';
import type { BlockToken } from './markdown-prep';

/**
 * Prepared Markdown -> ProseMirror JSON for one page.
 *
 * The conversion itself is S3b's `markdownToDoc` (core's markdownToHtml and
 * htmlToJson, plus page links -> mentions/internal links and `blob://<id>`
 * images -> the uploaded attachment). It is given a narrow stand-in for the
 * MCP tool context: pages are looked up in the import plan (all ids are
 * allocated before any content is written, so links to pages created later
 * in the run resolve), attachments in the database. After it, token
 * paragraphs become the nodes Markdown cannot carry: database blocks (S4a,
 * at their marker), attachments and YouTube embeds.
 */

export type PlannedPage = {
  id: string;
  slugId: string;
  title: string | null;
  spaceId: string;
};

export type AttachmentInfo = {
  id: string;
  fileName: string;
  mimeType: string | null;
  fileSize: number | null;
  workspaceId: string;
};

export type ConvertDeps = {
  baseUrl: string;
  workspaceId: string;
  /** Mention author (`data-creator-id`): the page's creator. */
  userId: string;
  /** AFFiNE doc id (from `affine://`) -> planned page. */
  pageFor: (ref: string) => PlannedPage | null;
  spaceSlug: (spaceId: string) => string | null;
  attachment: (id: string) => Promise<AttachmentInfo | null>;
};

export type ConvertResult = {
  json: any;
  attachmentIds: string[];
  linkedPageIds: string[];
  warnings: string[];
  databasesPlaced: string[];
  databasesMissing: string[];
};

function narrowContext(deps: ConvertDeps): McpToolContext {
  return {
    baseUrl: deps.baseUrl,
    workspace: { id: deps.workspaceId },
    user: { id: deps.userId },
    findReadablePage: async (ref: string) => deps.pageFor(ref),
    deps: {
      spaceRepo: {
        findById: async (id: string) => {
          const slug = deps.spaceSlug(id);
          return slug ? { id, slug } : null;
        },
      },
      attachmentRepo: { findById: (id: string) => deps.attachment(id) },
    },
  } as unknown as McpToolContext;
}

const textOf = (node: any): string =>
  node?.type === 'text'
    ? (node.text ?? '')
    : (node?.content ?? []).map(textOf).join('');

/** Replaces token paragraphs anywhere in the tree (pure). */
export function replaceTokens(
  doc: any,
  replace: (token: string) => any | null | undefined,
): any {
  const visit = (node: any): any[] => {
    if (!node || typeof node !== 'object') return [node];
    if (node.type === 'paragraph') {
      const text = textOf(node).trim();
      if (/^[A-Z]+:[a-z]+:\S+$/.test(text)) {
        const out = replace(text);
        if (out !== undefined) return out === null ? [] : [out];
      }
    }
    if (!Array.isArray(node.content)) return [node];
    const content = node.content.flatMap(visit);
    return [{ ...node, content }];
  };
  const [result] = visit(doc);
  if (!result.content?.length) result.content = [{ type: 'paragraph' }];
  return result;
}

export async function convertMarkdown(
  markdown: string,
  title: string | null,
  deps: ConvertDeps,
  blocks: { tokens: BlockToken[]; databases: Map<string, DatabaseData>; blobAttachment: (key: string) => AttachmentInfo | null },
): Promise<ConvertResult> {
  const parsed = await markdownToDoc(narrowContext(deps), markdown, { title });
  const byToken = new Map(blocks.tokens.map((t) => [t.token, t]));
  const databasesPlaced: string[] = [];
  const databasesMissing: string[] = [];
  const attachmentIds = new Set(parsed.attachmentIds);
  const warnings = [...parsed.warnings];
  const dbPrefix = `${KEEP_TOKEN}:database:`;

  const json = replaceTokens(parsed.json, (token) => {
    if (token.startsWith(dbPrefix)) {
      const id = token.slice(dbPrefix.length);
      const data = blocks.databases.get(id);
      if (!data || databasesPlaced.includes(id)) {
        databasesMissing.push(id);
        return null;
      }
      databasesPlaced.push(id);
      return databaseToJson(data);
    }
    const block = byToken.get(token);
    if (!block) return undefined;
    if (block.kind === 'youtube') {
      return { type: 'embed', attrs: { src: block.attrs.url, provider: 'youtube' } };
    }
    const attachment = blocks.blobAttachment(block.attrs.blob);
    if (!attachment) {
      warnings.push(`attachment ${block.attrs.name ?? block.attrs.blob} not found`);
      return null;
    }
    attachmentIds.add(attachment.id);
    return {
      type: 'attachment',
      attrs: {
        url: fileUrl(attachment),
        name: block.attrs.name || attachment.fileName,
        mime: attachment.mimeType,
        size: attachment.fileSize,
        attachmentId: attachment.id,
      },
    };
  });

  // Databases whose marker did not survive (should not happen) go to the end.
  for (const [id, data] of blocks.databases) {
    if (databasesPlaced.includes(id)) continue;
    json.content.push(databaseToJson(data));
    databasesPlaced.push(id);
    warnings.push(`database ${id} had no marker; appended at the end`);
  }

  jsonToNode(json).check();
  return {
    json,
    attachmentIds: [...attachmentIds],
    linkedPageIds: parsed.linkedPages.map((p) => p.docId),
    warnings,
    databasesPlaced,
    databasesMissing,
  };
}
