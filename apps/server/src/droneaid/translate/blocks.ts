import { createHash } from 'node:crypto';
import { getSchema } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { DATABASE_NODE, markdownToHtml } from '@docmost/editor-ext';
import {
  htmlToJson,
  jsonToMarkdown,
  jsonToNode,
  tiptapExtensions,
} from '../../collaboration/collaboration.util';
import { normalizeBlock, PLACEHOLDER } from './markdown';

/**
 * A page <-> the Markdown blocks the model translates.
 *
 * Only the text is translated; the page's structure never goes through the
 * model. Every text block of the page (paragraph, heading, list item text,
 * table cell text, callout text, details summary, ...) becomes one Markdown
 * block, exported through Docmost's own JSON -> Markdown path. The translated
 * blocks come back through Docmost's own Markdown -> JSON path
 * (markdownToHtml + htmlToJson), and only their inline content replaces the
 * text of the block they came from. So everything else is kept as it is:
 *  - containers and their attributes (lists, tables with widths and merged
 *    cells, columns, tabs, callouts, details, alignment, ids);
 *  - blocks with no text to translate (images, files, embeds, video, Draw.io,
 *    Excalidraw, math blocks, code blocks, sub-page lists, transclusions) are
 *    untouched, in place;
 *  - databases are kept untranslated in place (cell values are data: select
 *    options, numbers, dates and names must stay what filters and the MCP
 *    tools see);
 *  - inline nodes Markdown cannot carry (mentions, inline math, status,
 *    footnote references, ...) travel as ⟦n⟧ placeholders and are put back.
 * Formatting lost on the way: underline and text colour inside translated
 * text (turndown drops them).
 */

/** Text blocks whose text is not translated (code, math source). */
const UNTRANSLATED_TEXTBLOCKS: ReadonlySet<string> = new Set([
  'codeBlock',
  'mathBlock',
]);

/** Subtrees kept exactly as they are. */
const OPAQUE_NODES: ReadonlySet<string> = new Set([DATABASE_NODE]);

let schemaCache: Schema | null = null;
const schema = () => (schemaCache ??= getSchema(tiptapExtensions));

function isTextblock(type: string): boolean {
  return !!schema().nodes[type]?.isTextblock;
}

export type Extracted = {
  /** One Markdown block per translatable text block, in document order. */
  blocks: string[];
  /** Path (child indexes from the doc) of the text block behind each block. */
  paths: number[][];
  /** Placeholder number -> the inline node it stands for. */
  inline: Map<string, any>;
};

const HAS_WORD = /\p{L}/u;

function withoutCommentMarks(node: any): any {
  if (!node?.marks) return node;
  const marks = node.marks.filter((mark: any) => mark?.type !== 'comment');
  const { marks: _drop, ...rest } = node;
  return marks.length ? { ...rest, marks } : rest;
}

/** Removes comment marks everywhere (they are not content). Pure. */
export function stripCommentMarks(node: any): any {
  if (!node || typeof node !== 'object') return node;
  const clean = withoutCommentMarks(node);
  return Array.isArray(clean.content)
    ? { ...clean, content: clean.content.map(stripCommentMarks) }
    : clean;
}

/** Schema defaults filled in, block ids and comment marks dropped. */
function normalizeForHash(content: any): any {
  let doc = content;
  try {
    doc = jsonToNode(content).toJSON();
  } catch {
    // hash what we have
  }
  const visit = (node: any): any => {
    if (!node || typeof node !== 'object') return node;
    const clean = withoutCommentMarks(node);
    const attrs = clean.attrs ? { ...clean.attrs } : undefined;
    if (attrs) delete attrs.id;
    return {
      ...clean,
      ...(attrs ? { attrs } : {}),
      ...(Array.isArray(clean.content)
        ? { content: clean.content.map(visit) }
        : {}),
    };
  };
  return visit(doc);
}

/**
 * Changes whenever the title or the content changes. Ignores what the
 * editor adds on its own when a page is opened (block ids, attribute
 * defaults) and comments, so they do not flag translations out of date.
 */
export function sourceHash(title: string | null, content: any): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        title: title ?? '',
        content: normalizeForHash(content),
      }),
    )
    .digest('hex');
}

/** Turndown writes highlight as ==text==, which marked does not read back. */
function highlightToHtml(markdown: string): string {
  return markdown.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
}

function blockMarkdown(node: any, inline: any[]): string {
  const block =
    node.type === 'heading'
      ? {
          type: 'heading',
          attrs: { level: node.attrs?.level ?? 1 },
          content: inline,
        }
      : { type: 'paragraph', content: inline };
  return normalizeBlock(jsonToMarkdown({ type: 'doc', content: [block] }));
}

export function extractBlocks(doc: any): Extracted {
  const blocks: string[] = [];
  const paths: number[][] = [];
  const inline = new Map<string, any>();

  const visit = (node: any, path: number[]) => {
    if (!node || typeof node !== 'object' || OPAQUE_NODES.has(node.type)) {
      return;
    }
    if (isTextblock(node.type)) {
      if (UNTRANSLATED_TEXTBLOCKS.has(node.type)) return;
      const text = (node.content ?? [])
        .filter((child: any) => child?.type === 'text')
        .map((child: any) => child.text)
        .join('');
      if (!HAS_WORD.test(text)) return;
      const content: any[] = (node.content ?? []).map((child: any) => {
        if (child?.type === 'text') return withoutCommentMarks(child);
        if (child?.type === 'hardBreak') return child;
        const id = String(inline.size + 1);
        inline.set(id, child);
        return { type: 'text', text: `⟦${id}⟧` };
      });
      blocks.push(blockMarkdown(node, content));
      paths.push(path);
      return;
    }
    (node.content ?? []).forEach((child: any, i: number) =>
      visit(child, [...path, i]),
    );
  };
  visit(doc, []);
  return { blocks, paths, inline };
}

/** Inline content of the text blocks in parsed JSON, in order. */
function inlineOf(json: any): any[] {
  const out: any[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (isTextblock(node.type)) {
      if (out.length) out.push({ type: 'text', text: ' ' });
      out.push(...(node.content ?? []));
      return;
    }
    (node.content ?? []).forEach(visit);
  };
  visit(json);
  return out;
}

/** Splits text nodes on ⟦n⟧ and puts the original inline nodes back. */
function restorePlaceholders(
  nodes: any[],
  inline: ReadonlyMap<string, any>,
): any[] {
  return nodes.flatMap((node) => {
    if (node?.type !== 'text' || !node.text.includes('⟦')) return [node];
    const parts: any[] = [];
    let last = 0;
    for (const match of node.text.matchAll(PLACEHOLDER)) {
      const original = inline.get(match[1]);
      if (!original) continue;
      const before = node.text.slice(last, match.index);
      if (before) parts.push({ ...node, text: before });
      parts.push(original);
      last = match.index + match[0].length;
    }
    const rest = node.text.slice(last);
    if (rest) parts.push({ ...node, text: rest });
    return parts;
  });
}

/** Markdown of one translated block -> inline ProseMirror content. */
export async function blockToInline(
  markdown: string,
  inline: ReadonlyMap<string, any>,
): Promise<any[]> {
  const html = await markdownToHtml(highlightToHtml(markdown));
  const json = htmlToJson(html as string);
  return restorePlaceholders(inlineOf(json), inline);
}

function setContentAt(doc: any, path: number[], content: any[]): any {
  if (!path.length) {
    const { content: _old, ...rest } = doc;
    return content.length ? { ...rest, content } : rest;
  }
  const [head, ...tail] = path;
  const children = [...doc.content];
  children[head] = setContentAt(children[head], tail, content);
  return { ...doc, content: children };
}

/**
 * The page with each extracted text block's text replaced by its
 * translation. Throws when the result is not a valid document. Pure apart
 * from the async Markdown parser.
 */
export async function applyBlocks(
  doc: any,
  extracted: Extracted,
  translated: string[],
): Promise<any> {
  if (translated.length !== extracted.blocks.length) {
    throw new Error('Translated block count does not match the source.');
  }
  let result = stripCommentMarks(doc);
  for (let i = 0; i < translated.length; i++) {
    const content = await blockToInline(translated[i], extracted.inline);
    result = setContentAt(result, extracted.paths[i], content);
  }
  jsonToNode(result).check();
  return result;
}

/** `# Title` as the first block, so the title costs no extra request. */
export function titleBlock(title: string): string {
  return `# ${title.replace(/\s+/g, ' ').trim()}`;
}

export function titleFromBlock(block: string): string {
  return block.replace(/^\s*#+\s*/, '').trim();
}
