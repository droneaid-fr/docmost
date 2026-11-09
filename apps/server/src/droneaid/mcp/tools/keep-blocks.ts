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
 *  - a container Markdown would flatten (a synced block, a column layout,
 *    tabs) where its `<!-- <kind> id=X start ... -->` marker stands;
 *    read_document shows its content between that line and
 *    `<!-- <kind> id=X end -->` for reading only, and whatever stands
 *    between the two lines is ignored here;
 *  - a file/embed block where a paragraph holding only a link (or an image)
 *    to the same URL stands, which is how read_document renders it;
 *  - otherwise, a file/embed block after the block that preceded it before,
 *    when that block's text is still found; else at the end. A database or
 *    container whose marker is missing always goes to the end.
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
  'pageBreak',
]);

/**
 * Containers Markdown flattens into plain blocks, by their marker kind.
 * They are kept whole: a synced block (transclusionSource) because other
 * pages show it and core deletes its `page_transclusions` row when it
 * disappears; columns and tabs because Markdown has no layout.
 */
export const KEPT_CONTAINERS: ReadonlyMap<string, string> = new Map([
  ['transclusionSource', 'synced-block'],
  ['columns', 'columns'],
  ['tabs', 'tabs'],
]);

const CONTAINER_DESCRIPTION: Record<string, string> = {
  'synced-block': 'a synced block that other pages show',
  columns: 'a column layout',
  tabs: 'a set of tabs',
};

/** Blocks update_document never rebuilds from Markdown. */
export const isKeptType = (type: unknown): boolean =>
  typeof type === 'string' &&
  (KEPT_NODE_TYPES.has(type) || KEPT_CONTAINERS.has(type));

/**
 * Keys for the outermost kept containers of a doc, in document order: a
 * synced block by its id, columns and tabs by their rank among their kind
 * (they have no id). read_document and update_document both number them
 * with this, so the marker a caller sends back finds the same block.
 */
export function containerKeyer(): (node: any) => string | null {
  const seen = new Map<string, number>();
  return (node: any) => {
    const kind = KEPT_CONTAINERS.get(node?.type);
    if (!kind) return null;
    const rank = (seen.get(kind) ?? 0) + 1;
    seen.set(kind, rank);
    const id = String(node.attrs?.id ?? '');
    const key =
      kind === 'synced-block' && /^[A-Za-z0-9_-]+$/.test(id) ? id : `${rank}`;
    return `${kind}:${key}`;
  };
}

/** The start/end lines read_document writes around a kept container. */
export function containerMarker(key: string, edge: 'start' | 'end'): string {
  const [kind, id] = key.split(':');
  if (edge === 'end') return `<!-- ${kind} id=${id} end -->`;
  return `<!-- ${kind} id=${id} start: ${CONTAINER_DESCRIPTION[kind] ?? kind}. update_document keeps it as it is (edit it in the editor); the lines up to its end marker are shown for reading only. -->`;
}

/** `<!-- database id=X -->`, or the long form read_document writes. */
const DATABASE_MARKER_LINE =
  /^[ \t]*<!--\s*database\s+id=([A-Za-z0-9_-]+)(?:\s[^\n]*?)?\s*-->[ \t]*$/;
const CONTAINER_MARKER_LINE =
  /^[ \t]*<!--\s*(synced-block|columns|tabs)\s+id=([A-Za-z0-9_-]+)\s+(start|end)\b[^\n]*?-->[ \t]*$/;
const FENCE = /^[ \t]{0,3}(```|~~~)/;

export type ScannedMarkers = {
  markdown: string;
  /** What stood between a container's start and end lines, by key. */
  regions: Map<string, string>;
};

/**
 * Turns each marker line (outside code fences) into a paragraph holding a
 * plain token, which survives Markdown -> HTML -> JSON; HTML comments do not.
 * A container's start line, its end line and everything between them become
 * one token. A start line without its end line becomes a token alone; a
 * stray end line is dropped.
 */
export function scanMarkers(markdown: string): ScannedMarkers {
  const lines = markdown.split('\n');
  const inFence: boolean[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const opening = FENCE.exec(line);
    if (opening) {
      inFence.push(true);
      if (!fence) fence = opening[1];
      else if (opening[1] === fence) fence = null;
      continue;
    }
    inFence.push(fence !== null);
  }
  const container = (i: number) =>
    inFence[i] ? null : CONTAINER_MARKER_LINE.exec(lines[i]);

  const out: string[] = [];
  const regions = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) {
      out.push(lines[i]);
      continue;
    }
    const marker = container(i);
    if (marker) {
      const [, kind, id, edge] = marker;
      if (edge === 'end') continue;
      const key = `${kind}:${id}`;
      out.push(`\n${KEEP_TOKEN}:${key}\n`);
      let end = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const m = container(j);
        if (m && m[1] === kind && m[2] === id && m[3] === 'end') {
          end = j;
          break;
        }
      }
      if (end >= 0) {
        regions.set(key, lines.slice(i + 1, end).join('\n'));
        i = end;
      }
      continue;
    }
    const db = DATABASE_MARKER_LINE.exec(lines[i]);
    out.push(db ? `\n${KEEP_TOKEN}:database:${db[1]}\n` : lines[i]);
  }
  return { markdown: out.join('\n'), regions };
}

export function markersToTokens(markdown: string): string {
  return scanMarkers(markdown).markdown;
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

function keyOf(
  node: any,
  baseUrl: string,
  containerKey: (node: any) => string | null,
): string | null {
  if (KEPT_CONTAINERS.has(node.type)) return containerKey(node);
  if (node.type === DATABASE_NODE) {
    return node.attrs?.id ? `database:${node.attrs.id}` : null;
  }
  return normalizeUrl(node.attrs?.src ?? node.attrs?.url, baseUrl);
}

/** Kept blocks of the current doc, in document order. */
export function collectKept(current: any, baseUrl = ''): Kept[] {
  const found: Kept[] = [];
  const topLevel: any[] = current?.content ?? [];
  const containerKey = containerKeyer();
  const walk = (node: any, anchor: string | null) => {
    for (const child of node?.content ?? []) {
      if (!child || typeof child !== 'object') continue;
      if (isKeptType(child.type)) {
        found.push({
          node: child,
          type: child.type,
          key: keyOf(child, baseUrl, containerKey),
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
      if (isKeptType(topLevel[i]?.type)) continue;
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

const TOKEN_TEXT = new RegExp(
  `^${KEEP_TOKEN}:(database|synced-block|columns|tabs):([A-Za-z0-9_-]+)$`,
);

function tokenOf(node: any): string | null {
  if (node?.type !== 'paragraph') return null;
  const text = normText(nodeText(node));
  const match = TOKEN_TEXT.exec(text);
  return match ? `${match[1]}:${match[2]}` : null;
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
  hit.report = report(hit, placement);
  return hit.node;
}

function report(k: Kept, placement: KeptPlacement): KeptReport {
  const id =
    k.type === DATABASE_NODE
      ? k.node.attrs?.id
      : KEPT_CONTAINERS.has(k.type)
        ? k.key?.split(':')[1]
        : undefined;
  return { type: k.type, ...(id ? { id } : {}), placement };
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
  // Blocks placed only by their marker; the others follow links/anchors.
  const byMarker = (k: Kept) =>
    k.type === DATABASE_NODE || KEPT_CONTAINERS.has(k.type);
  const isDatabase = (k: Kept) => k.type === DATABASE_NODE;
  const isFile = (k: Kept) => !byMarker(k);

  const place = (nodes: any[]): any[] =>
    nodes.flatMap((node) => {
      if (!node || typeof node !== 'object') return [node];
      const token = tokenOf(node);
      if (token) {
        // A marker for a block that is not here (or was used) is dropped.
        const block = take(kept, token, 'marker', byMarker);
        return block ? [block] : [];
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
      !byMarker(k) && k.anchor
        ? blocks.findIndex(
            (b) =>
              !isKeptType(b?.type) &&
              normText(nodeText(b)) === k.anchor,
          )
        : -1;
    if (anchorIndex >= 0) {
      // After the anchor and any kept blocks already placed right after it.
      let at = anchorIndex + 1;
      while (at < blocks.length && isKeptType(blocks[at]?.type)) at++;
      blocks = [...blocks.slice(0, at), k.node, ...blocks.slice(at)];
      k.report = report(k, 'anchor');
    } else {
      atEnd.push(k.node);
      k.report = report(k, 'end');
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

/** Letters and digits only, so Markdown syntax does not count as a change. */
function letters(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Readable text of a block, skipping kept blocks inside it. */
function readableText(node: any): string {
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'status') return node.attrs?.text ?? '';
  if (node.type === 'mention') return node.attrs?.label ?? '';
  return (node.content ?? [])
    .filter((c: any) => !KEPT_NODE_TYPES.has(c?.type))
    .map(readableText)
    .join(' ');
}

const markdownLetters = (markdown: string) =>
  letters(
    markdown
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\]\([^)]*\)/g, ']')
      .replace(/<[^>]+>/g, ' '),
  );

/**
 * Warnings for containers whose content the caller edited between its
 * markers: those edits are ignored, since the container is kept as it is.
 */
export function ignoredRegionEdits(
  current: any,
  regions: ReadonlyMap<string, string>,
  baseUrl = '',
): string[] {
  if (!regions.size) return [];
  const live = new Map(
    collectKept(current, baseUrl)
      .filter((k) => KEPT_CONTAINERS.has(k.type) && k.key)
      .map((k) => [k.key, k.node]),
  );
  const warnings: string[] = [];
  for (const [key, text] of regions) {
    const node = live.get(key);
    if (!node) continue;
    if (markdownLetters(text) !== letters(readableText(node))) {
      const [kind, id] = key.split(':');
      warnings.push(
        `Your changes between the ${kind} id=${id} start and end markers were ignored: update_document keeps ${CONTAINER_DESCRIPTION[kind] ?? kind} as it is. Edit it in the editor, or put new text outside the markers.`,
      );
    }
  }
  return warnings;
}
