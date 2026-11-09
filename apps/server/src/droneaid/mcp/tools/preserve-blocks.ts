import { isKeptType } from './keep-blocks';

/**
 * Markdown carries text, a few marks and a few attributes. Everything else on
 * a block (comment marks, alignment, colour, highlight, underline, status
 * badges, block ids) is lost when update_document rebuilds the block from
 * Markdown, and y-prosemirror's diff then removes it from the live doc.
 *
 * So, after the kept blocks are placed (keep-blocks.ts), each incoming block
 * is compared with the live blocks:
 *  - a live block that Markdown renders the same way is used as it is, so
 *    the diff sees no change there at all;
 *  - a paragraph or heading whose text is unchanged but whose Markdown
 *    formatting changed (bold, a link, ...) gets the live block's attributes
 *    back, and the live marks Markdown cannot carry (comments first) on the
 *    same characters;
 *  - anything else is new text, and what it loses is reported in warnings.
 */

/** Marks Markdown carries; any other mark only exists in the live doc. */
const MD_MARKS: ReadonlySet<string> = new Set([
  'bold',
  'italic',
  'strike',
  'code',
  'link',
]);

/** Attributes Markdown carries, per node type. */
const MD_ATTRS: Record<string, string[]> = {
  heading: ['level'],
  taskItem: ['checked'],
  codeBlock: ['language'],
  orderedList: ['start'],
  callout: ['type'],
  image: ['src'],
  mention: ['entityId'],
  mathInline: ['text'],
  mathBlock: ['text'],
};

const TEXTBLOCKS: ReadonlySet<string> = new Set(['paragraph', 'heading']);

type Segment = { text: string; key: string };

/** Readable text of an inline node, as read_document renders it. */
function inlineText(node: any): string {
  switch (node?.type) {
    case 'text':
      return node.text ?? '';
    case 'status':
      return node.attrs?.text ?? '';
    case 'mention':
      return node.attrs?.label ?? '';
    case 'hardBreak':
      return '\n';
    default:
      return '';
  }
}

/** `==x==` is how a highlight comes back from Markdown. */
const clean = (text: string) => text.replace(/==/g, '');

function segments(node: any): Segment[] {
  const out: Segment[] = [];
  for (const child of node?.content ?? []) {
    let key: string;
    if (child.type === 'text' || child.type === 'status') {
      key = (child.marks ?? [])
        .filter((m: any) => MD_MARKS.has(m.type))
        .map((m: any) =>
          m.type === 'link' ? `link:${m.attrs?.href ?? ''}` : m.type,
        )
        .sort()
        .join(',');
    } else if (child.type === 'hardBreak') {
      key = '';
    } else {
      key = `${child.type}:${JSON.stringify(mdAttrs(child))}`;
    }
    const text = clean(inlineText(child));
    const last = out[out.length - 1];
    if (last && last.key === key && !key.includes(':{')) last.text += text;
    else out.push({ text, key });
  }
  return out
    .map((s) => ({ ...s, text: s.text.replace(/\s+/g, ' ') }))
    .filter((s) => s.text || s.key);
}

function mdAttrs(node: any): Record<string, unknown> {
  const names = MD_ATTRS[node?.type] ?? [];
  return Object.fromEntries(names.map((n) => [n, node.attrs?.[n] ?? null]));
}

const isInlineContainer = (node: any) =>
  (node?.content ?? []).some(
    (c: any) => c?.type === 'text' || c?.type === 'hardBreak',
  ) || TEXTBLOCKS.has(node?.type);

/** How Markdown sees a node: equal for a live block and its round trip. */
function canon(node: any): string {
  if (!node || typeof node !== 'object') return '';
  const head = `${node.type}${JSON.stringify(mdAttrs(node))}`;
  if (isInlineContainer(node)) {
    const segs = segments(node);
    if (segs.length) {
      segs[0].text = segs[0].text.trimStart();
      segs[segs.length - 1].text = segs[segs.length - 1].text.trimEnd();
    }
    return `${head}(${JSON.stringify(segs)})`;
  }
  return `${head}[${(node.content ?? []).map(canon).join(',')}]`;
}

const plainText = (node: any): string =>
  (node?.content ?? []).map(inlineText).join('');
const plainKey = (node: any) =>
  `${node?.type}|${clean(plainText(node)).replace(/\s+/g, ' ').trim()}`;

const hasKept = (node: any): boolean =>
  isKeptType(node?.type) || (node?.content ?? []).some(hasKept);

type Entry = { node: any; used: boolean; members: Entry[] };

/** Live nodes outside kept blocks, by canon and by plain text. */
function buildPool(current: any) {
  const byCanon = new Map<string, Entry[]>();
  const byText = new Map<string, Entry[]>();
  const add = (map: Map<string, Entry[]>, key: string, e: Entry) => {
    const list = map.get(key);
    if (list) list.push(e);
    else map.set(key, [e]);
  };
  const visit = (node: any): Entry[] => {
    if (!node || typeof node !== 'object' || isKeptType(node.type)) return [];
    const childEntries = (node.content ?? []).flatMap(visit);
    if (node.type === 'text' || hasKept(node)) return childEntries;
    const entry: Entry = { node, used: false, members: childEntries };
    add(byCanon, canon(node), entry);
    if (TEXTBLOCKS.has(node.type)) add(byText, plainKey(node), entry);
    return [entry, ...childEntries];
  };
  (current?.content ?? []).forEach(visit);
  const claim = (list: Entry[] | undefined): any | null => {
    const hit = list?.find((e) => !e.used);
    if (!hit) return null;
    const mark = (e: Entry) => {
      e.used = true;
      e.members.forEach(mark);
    };
    mark(hit);
    return hit.node;
  };
  return {
    sameMarkdown: (node: any) => claim(byCanon.get(canon(node))),
    sameText: (node: any) => claim(byText.get(plainKey(node))),
  };
}

type Run = { start: number; end: number; marks: any[] };

/** Character ranges of the live marks Markdown cannot carry. */
function liveOnlyRuns(node: any): Run[] {
  const runs: Run[] = [];
  let at = 0;
  for (const child of node?.content ?? []) {
    const len = inlineText(child).length;
    const marks = (child.marks ?? []).filter((m: any) => !MD_MARKS.has(m.type));
    if (child.type === 'text' && marks.length && len) {
      runs.push({ start: at, end: at + len, marks });
    }
    at += len;
  }
  return runs;
}

/**
 * The incoming textblock with the live block's attributes and live-only
 * marks. Marks move only when the text is exactly the same, so they land on
 * the same characters.
 */
function transplant(live: any, incoming: any): any {
  const attrs = { ...(live.attrs ?? {}), ...mdAttrs(incoming) };
  if (plainText(live) !== plainText(incoming)) return { ...incoming, attrs };
  const runs = liveOnlyRuns(live);
  const content: any[] = [];
  let at = 0;
  for (const child of incoming.content ?? []) {
    const len = inlineText(child).length;
    if (child.type !== 'text' || !runs.length) {
      content.push(child);
      at += len;
      continue;
    }
    const cuts = new Set([at, at + len]);
    for (const r of runs) {
      if (r.start > at && r.start < at + len) cuts.add(r.start);
      if (r.end > at && r.end < at + len) cuts.add(r.end);
    }
    const points = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i < points.length - 1; i++) {
      const [from, to] = [points[i], points[i + 1]];
      const own: any[] = child.marks ?? [];
      const extra = runs
        .filter((r) => r.start <= from && r.end >= to)
        .flatMap((r) => r.marks)
        .filter((m) => !own.some((o) => o.type === m.type));
      const marks = [...own, ...extra];
      content.push({
        type: 'text',
        text: child.text.slice(from - at, to - at),
        ...(marks.length ? { marks } : {}),
      });
    }
    at += len;
  }
  return { ...incoming, attrs, content };
}

const FEATURE_NAMES: Record<string, string> = {
  highlight: 'highlight',
  textStyle: 'text colour',
  underline: 'underline',
};

/** Comment ids and lossy features of a doc, to report what was lost. */
function inventory(doc: any) {
  const comments = new Set<string>();
  // Amounts: characters for marks (splitting a text node changes nothing),
  // nodes otherwise.
  const features = new Map<string, number>();
  const count = (name: string, n = 1) =>
    features.set(name, (features.get(name) ?? 0) + n);
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    for (const mark of node.marks ?? []) {
      if (mark.type === 'comment' && mark.attrs?.commentId) {
        comments.add(mark.attrs.commentId);
      } else if (!MD_MARKS.has(mark.type)) {
        count(FEATURE_NAMES[mark.type] ?? mark.type, node.text?.length ?? 1);
      }
    }
    if (node.type === 'status') count('status badge');
    if (node.attrs?.textAlign && node.attrs.textAlign !== 'left') {
      count('text alignment');
    }
    if (!isKeptType(node.type)) (node.content ?? []).forEach(visit);
  };
  visit(doc);
  return { comments, features };
}

export type Preserved = { doc: any; warnings: string[] };

/**
 * `doc` (the composed new body) with live blocks reused where the caller did
 * not change them, and warnings for the comments and formatting that the
 * caller's rewrites lose. Kept blocks in `doc` are left alone. Pure.
 */
export function preserveUnchanged(current: any, doc: any): Preserved {
  const pool = buildPool(current);
  const visit = (node: any): any => {
    if (!node || typeof node !== 'object' || node.type === 'text') return node;
    if (isKeptType(node.type)) return node;
    const same = pool.sameMarkdown(node);
    if (same) return same;
    if (TEXTBLOCKS.has(node.type)) {
      const live = pool.sameText(node);
      if (live) return transplant(live, node);
    }
    return Array.isArray(node.content)
      ? { ...node, content: node.content.map(visit) }
      : node;
  };
  const out = {
    ...doc,
    content: (doc?.content ?? []).map(visit),
  };

  const before = inventory(current);
  const after = inventory(out);
  const warnings: string[] = [];
  const lostComments = [...before.comments].filter(
    (id) => !after.comments.has(id),
  );
  if (lostComments.length) {
    warnings.push(
      `The text these comments were attached to was rewritten or removed, so they no longer point at any text: ${lostComments.join(', ')}. Keep a commented sentence word for word to keep its comment.`,
    );
  }
  const lost = [...before.features]
    .filter(([name, n]) => n > (after.features.get(name) ?? 0))
    .map(([name]) => name);
  if (lost.length) {
    warnings.push(
      `Formatting Markdown cannot carry was dropped from rewritten blocks: ${lost.join(', ')}.`,
    );
  }
  return { doc: out, warnings };
}
