import { DATABASE_NODE } from '@docmost/editor-ext';

/**
 * update_document replaces a page body with Markdown, but Markdown cannot
 * carry every block. This module decides, on ProseMirror JSON, where the
 * blocks it cannot carry go in the new body, so that none is silently lost.
 *
 * Kept blocks are taken from the live document (never from the Markdown),
 * then placed:
 *  - a database where its marker line `<!-- database id=X -->` (or its full
 *    `<!-- droneaid:database {...} -->` export) stands; database data is only
 *    ever changed by the database tools, never by Markdown;
 *  - a file/embed block where a paragraph holding only a link (or an image)
 *    to the same URL stands, which is how read_document renders it;
 *  - otherwise, a file/embed block after the block that preceded it before,
 *    when that block's text is still found; else at the end. A database
 *    whose marker is missing always goes to the end.
 * The caller then applies the result with y-prosemirror's diff, so a block
 * kept in place keeps its Yjs identity.
 */

export const KEEP_TOKEN = 'DRONEAIDKEEP';

/** Block nodes Markdown cannot represent (or only as a lossy link). */
export const KEPT_NODE_TYPES: ReadonlySet<string> = new Set([
  DATABASE_NODE,
  'attachment',
  'video',
  'audio',
  'pdf',
  'drawio',
  'excalidraw',
  'embed',
  'youtube',
  'subpages',
  'transclusionReference',
  'base',
  'integrationCard',
]);

const DATABASE_MARKER_LINE =
  /^[ \t]*<!--\s*database\s+id=([A-Za-z0-9_-]+)\s*-->[ \t]*$/;
const FENCE = /^[ \t]{0,3}(```|~~~)/;

/**
 * Turns each marker line (outside code fences) into a paragraph holding a
 * plain token, which survives Markdown -> HTML -> JSON; HTML comments do not.
 */
export function markersToTokens(markdown: string): string {
  let fence: string | null = null;
  return markdown
    .split('\n')
    .map((line) => {
      const opening = FENCE.exec(line);
      if (opening) {
        if (!fence) fence = opening[1];
        else if (opening[1] === fence) fence = null;
        return line;
      }
      if (fence) return line;
      const marker = DATABASE_MARKER_LINE.exec(line);
      return marker ? `\n${KEEP_TOKEN}:database:${marker[1]}\n` : line;
    })
    .join('\n');
}

export type KeptPlacement = 'marker' | 'link' | 'anchor' | 'end';

export type KeptReport = {
  type: string;
  id?: string;
  placement: KeptPlacement;
};

type Kept = {
  node: any;
  type: string;
  /** `database:<id>` or the block's normalised URL. */
  key: string | null;
  /** Text of the top-level block before it, for anchoring. */
  anchor: string | null;
  used: boolean;
  report?: KeptReport;
};

const nodeText = (node: any): string =>
  node?.type === 'text'
    ? (node.text ?? '')
    : (node?.content ?? []).map(nodeText).join('');

const normText = (text: string) => text.replace(/\s+/g, ' ').trim();

/** URL without our own origin, query or fragment, so forms compare equal. */
export function normalizeUrl(url: unknown, baseUrl = ''): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  let value = url.trim();
  if (baseUrl && value.startsWith(baseUrl)) value = value.slice(baseUrl.length);
  try {
    value = decodeURI(value);
  } catch {
    // keep as is
  }
  return value.replace(/[?#].*$/, '');
}

function keyOf(node: any, baseUrl: string): string | null {
  if (node.type === DATABASE_NODE) {
    return node.attrs?.id ? `database:${node.attrs.id}` : null;
  }
  return normalizeUrl(node.attrs?.src ?? node.attrs?.url, baseUrl);
}

/** Kept blocks of the current doc, in document order. */
export function collectKept(current: any, baseUrl = ''): Kept[] {
  const found: Kept[] = [];
  const topLevel: any[] = current?.content ?? [];
  const walk = (node: any, anchor: string | null) => {
    for (const child of node?.content ?? []) {
      if (!child || typeof child !== 'object') continue;
      if (KEPT_NODE_TYPES.has(child.type)) {
        found.push({
          node: child,
          type: child.type,
          key: keyOf(child, baseUrl),
          anchor,
          used: false,
        });
      } else if (Array.isArray(child.content)) {
        walk(child, anchor);
      }
    }
  };
  topLevel.forEach((block, index) => {
    // The nearest earlier top-level block that is not itself kept.
    let anchor: string | null = null;
    for (let i = index - 1; i >= 0; i--) {
      if (KEPT_NODE_TYPES.has(topLevel[i]?.type)) continue;
      anchor = normText(nodeText(topLevel[i])) || null;
      break;
    }
    walk({ content: [block] }, anchor);
  });
  return found;
}

/** The URL a paragraph points at when it holds just one link or image. */
function soleTarget(node: any, baseUrl: string): string | null {
  if (node?.type === 'image') return normalizeUrl(node.attrs?.src, baseUrl);
  if (node?.type !== 'paragraph') return null;
  const inline = (node.content ?? []).filter(
    (c: any) => !(c.type === 'text' && !c.text?.trim()),
  );
  if (!inline.length) return null;
  if (inline.length === 1 && inline[0].type === 'image') {
    return normalizeUrl(inline[0].attrs?.src, baseUrl);
  }
  const hrefs = new Set(
    inline.map((c: any) =>
      c.type === 'text'
        ? (c.marks ?? []).find((m: any) => m.type === 'link')?.attrs?.href
        : undefined,
    ),
  );
  if (hrefs.size !== 1) return null;
  const [href] = [...hrefs];
  return href ? normalizeUrl(href, baseUrl) : null;
}

function tokenOf(node: any): string | null {
  if (node?.type !== 'paragraph') return null;
  const text = normText(nodeText(node));
  const match = new RegExp(`^${KEEP_TOKEN}:database:([A-Za-z0-9_-]+)$`).exec(
    text,
  );
  return match ? `database:${match[1]}` : null;
}

function take(
  kept: Kept[],
  key: string | null,
  placement: KeptPlacement,
  filter: (k: Kept) => boolean = () => true,
): any | null {
  if (!key) return null;
  const hit = kept.find((k) => !k.used && k.key === key && filter(k));
  if (!hit) return null;
  hit.used = true;
  hit.report = {
    type: hit.type,
    ...(hit.type === DATABASE_NODE ? { id: hit.node.attrs?.id } : {}),
    placement,
  };
  return hit.node;
}

/**
 * The new doc: `incoming` (parsed from the caller's Markdown, tokens
 * included) with the current doc's kept blocks put back. Pure.
 */
export function composeWithKept(
  current: any,
  incoming: any,
  baseUrl = '',
): { doc: any; kept: KeptReport[] } {
  const kept = collectKept(current, baseUrl);
  const isDatabase = (k: Kept) => k.type === DATABASE_NODE;
  const isFile = (k: Kept) => k.type !== DATABASE_NODE;

  const place = (nodes: any[]): any[] =>
    nodes.flatMap((node) => {
      if (!node || typeof node !== 'object') return [node];
      const token = tokenOf(node);
      if (token) {
        // A marker for a database that is not here (or was used) is dropped.
        const db = take(kept, token, 'marker', isDatabase);
        return db ? [db] : [];
      }
      if (node.type === DATABASE_NODE) {
        // A full database export: keep the live database, not the copy.
        const key = `database:${node.attrs?.id}`;
        const db = take(kept, key, 'marker', isDatabase);
        if (db) return [db];
        // A second copy of a kept database is dropped; a new one is created.
        return kept.some((k) => k.key === key) ? [] : [node];
      }
      const target = soleTarget(node, baseUrl);
      const file = target ? take(kept, target, 'link', isFile) : null;
      if (file) return [file];
      return Array.isArray(node.content)
        ? [{ ...node, content: place(node.content) }]
        : [node];
    });

  let blocks = place(incoming?.content ?? []);

  // The doc schema is `block+ footnotes?`: anything appended goes before it.
  const footnotes =
    blocks.length && blocks[blocks.length - 1]?.type === 'footnotes'
      ? blocks[blocks.length - 1]
      : null;
  if (footnotes) blocks = blocks.slice(0, -1);

  const atEnd: any[] = [];
  for (const k of kept.filter((k) => !k.used)) {
    k.used = true;
    const anchorIndex =
      k.type !== DATABASE_NODE && k.anchor
        ? blocks.findIndex(
            (b) =>
              !KEPT_NODE_TYPES.has(b?.type) &&
              normText(nodeText(b)) === k.anchor,
          )
        : -1;
    if (anchorIndex >= 0) {
      // After the anchor and any kept blocks already placed right after it.
      let at = anchorIndex + 1;
      while (at < blocks.length && KEPT_NODE_TYPES.has(blocks[at]?.type)) at++;
      blocks = [...blocks.slice(0, at), k.node, ...blocks.slice(at)];
      k.report = { type: k.type, placement: 'anchor' };
    } else {
      atEnd.push(k.node);
      k.report = {
        type: k.type,
        ...(k.type === DATABASE_NODE ? { id: k.node.attrs?.id } : {}),
        placement: 'end',
      };
    }
  }
  blocks = [...blocks, ...atEnd];
  if (!blocks.length) blocks = [{ type: 'paragraph' }];
  if (footnotes) blocks = [...blocks, footnotes];

  return {
    doc: { ...(incoming ?? {}), type: 'doc', content: blocks },
    kept: kept.map((k) => k.report),
  };
}

/**
 * Images whose URL was already in the doc get their old attributes back
 * (size, alignment, attachment id), which Markdown does not carry.
 */
export function restoreImageAttrs(current: any, doc: any, baseUrl = ''): any {
  const before = new Map<string, any>();
  const scan = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'image') {
      const key = normalizeUrl(node.attrs?.src, baseUrl);
      if (key && !before.has(key)) before.set(key, node.attrs);
    }
    (node.content ?? []).forEach(scan);
  };
  scan(current);
  const visit = (node: any): any => {
    if (!node || typeof node !== 'object') return node;
    if (node.type === 'image') {
      const old = before.get(normalizeUrl(node.attrs?.src, baseUrl) ?? '');
      if (old) {
        return {
          ...node,
          attrs: {
            ...old,
            ...(node.attrs?.alt ? { alt: node.attrs.alt } : {}),
            src: old.src,
          },
        };
      }
    }
    return Array.isArray(node.content)
      ? { ...node, content: node.content.map(visit) }
      : node;
  };
  return visit(doc);
}

/** Removes stray tokens (create_document has no blocks to keep). */
export function dropTokens(doc: any): any {
  const visit = (nodes: any[]): any[] =>
    nodes
      .filter((node) => !tokenOf(node))
      .map((node) =>
        Array.isArray(node?.content)
          ? { ...node, content: visit(node.content) }
          : node,
      );
  const content = visit(doc?.content ?? []);
  return {
    ...doc,
    content: content.length ? content : [{ type: 'paragraph' }],
  };
}
