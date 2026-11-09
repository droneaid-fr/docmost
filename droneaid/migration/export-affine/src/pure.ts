/**
 * Pure transforms of the AFFiNE exporter: no I/O, no Yjs, no AFFiNE fork code.
 * Everything here is covered by test/pure.test.ts.
 */
import { createHash } from 'node:crypto';

// ------------------------------------------------------------------ JSON

/**
 * Deterministic JSON: object keys sorted, bigint as number (string when it
 * does not fit), bytes as base64, `undefined` dropped. Two-space indent and a
 * trailing newline, so files diff cleanly.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value), null, 2) + '\n';
}

function normalize(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString('base64') };
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = normalize(v);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Ascending by a string key, code-point order (locale independent). */
export function byKey<T>(key: (item: T) => string) {
  return (a: T, b: T) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
}

export function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'bigint') return new Date(Number(value)).toISOString();
  return null;
}

// ---------------------------------------------------------- block flavours

/** How a block flavour reaches the bundle. */
export type Handling =
  | 'markdown' // the fork's markdown reader renders it faithfully
  | 'structural' // container only (page, note): its children carry content
  | 'image' // `![caption](blob://<key>)` + file in blobs/
  | 'latex' // `$$ ... $$` block
  | 'database' // marker line + databases/<id>.json
  | 'marker' // `<!-- affine-block ... -->` line + entry in doc.json blocks
  | 'canvas'; // edgeless-only: not in the page body, raw JSON in canvas.json

const MARKDOWN_FLAVOURS = new Set([
  'affine:paragraph',
  'affine:list',
  'affine:code',
  'affine:divider',
  'affine:table',
]);
const STRUCTURAL_FLAVOURS = new Set(['affine:page', 'affine:note']);
const CANVAS_FLAVOURS = new Set([
  'affine:surface',
  'affine:frame',
  'affine:edgeless-text',
]);

/**
 * `onCanvas` is true for a block that sits under the surface block (edgeless
 * only, never part of the page body), whatever its flavour.
 */
export function handlingOf(flavour: string, onCanvas = false): Handling {
  if (onCanvas || CANVAS_FLAVOURS.has(flavour)) return 'canvas';
  if (STRUCTURAL_FLAVOURS.has(flavour)) return 'structural';
  if (MARKDOWN_FLAVOURS.has(flavour)) return 'markdown';
  if (flavour === 'affine:image') return 'image';
  if (flavour === 'affine:latex') return 'latex';
  if (flavour === 'affine:database') return 'database';
  return 'marker';
}

/** Blocks replaced by a sentinel before the markdown reader runs. */
export function needsSentinel(handling: Handling) {
  return (
    handling === 'image' ||
    handling === 'latex' ||
    handling === 'database' ||
    handling === 'marker'
  );
}

// ------------------------------------------------------------- markers

/** A value safe inside an HTML comment attribute: no `"`, no `--`, one line. */
export function markerValue(value: string): string {
  return value
    .replace(/%/g, '%25')
    .replace(/"/g, '%22')
    .replace(/--/g, '%2D%2D')
    .replace(/\r?\n/g, '%0A');
}

export function decodeMarkerValue(value: string): string {
  return decodeURIComponent(value);
}

/**
 * One self-describing line for a block markdown cannot carry. Attribute order
 * is fixed (id, flavour, then the rest sorted) so output is deterministic.
 */
export function blockMarker(
  id: string,
  flavour: string,
  attrs: Record<string, string | number | boolean | null | undefined> = {}
): string {
  const rest = Object.keys(attrs)
    .sort()
    .filter(key => attrs[key] !== undefined && attrs[key] !== null)
    .map(key => `${key}="${markerValue(String(attrs[key]))}"`);
  return `<!-- affine-block id=${id} flavour=${flavour}${rest.length ? ' ' + rest.join(' ') : ''} -->`;
}

const MARKER_LINE = /^<!-- affine-block id=(\S+) flavour=(\S+)((?: [a-zA-Z]+="[^"]*")*) -->$/;

export function parseBlockMarker(line: string) {
  const match = MARKER_LINE.exec(line.trim());
  if (!match) return null;
  const attrs: Record<string, string> = {};
  for (const m of match[3].matchAll(/ ([a-zA-Z]+)="([^"]*)"/g)) {
    attrs[m[1]] = decodeMarkerValue(m[2]);
  }
  return { id: match[1], flavour: match[2], attrs };
}

function oneLine(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

/** Markdown image; the alt text is the caption on one line, brackets removed. */
export function imageMarkdown(blobKey: string, caption = ''): string {
  const alt = oneLine(caption).replace(/[[\]]/g, '');
  return `![${alt}](blob://${blobKey})`;
}

/** A display-math block in the `$$` form Docmost's markdown import reads. */
export function latexMarkdown(latex: string): string {
  return `$$\n${latex.trim()}\n$$`;
}

/**
 * Replace the reader's sentinel lines (`AFFINEMCPBLOCK<hex>X`) with their
 * replacement text, indented like the sentinel (a block nested in a list item
 * stays inside it). Unknown sentinels are kept, so a missing replacement is
 * visible rather than silently dropped.
 */
export function replaceSentinels(
  markdown: string,
  replacements: Map<string, string>
): { markdown: string; missing: string[] } {
  const missing: string[] = [];
  const out = markdown.replace(
    /^([ \t]*)(AFFINEMCPBLOCK[0-9a-f]+X)[ \t]*$/gm,
    (line, indent: string, sentinel: string) => {
      const replacement = replacements.get(sentinel);
      if (replacement === undefined) {
        missing.push(sentinel);
        return line;
      }
      return replacement
        .split('\n')
        .map(l => (l ? indent + l : l))
        .join('\n');
    }
  );
  return { markdown: out, missing };
}

/** Collapse runs of 3+ blank lines the reader leaves around removed blocks. */
export function tidyMarkdown(markdown: string): string {
  return (
    markdown
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{4,}/g, '\n\n\n')
      .replace(/^\n+/, '')
      .replace(/\n*$/, '\n')
  );
}

// ---------------------------------------------------------- inline deltas

export type DeltaOp = {
  insert?: unknown;
  attributes?: Record<string, unknown>;
};

/**
 * Inline LaTeX is an op `{insert: ' ', attributes: {latex}}`; the markdown
 * reader drops it. Turn it into `$latex$` text (Docmost's inline math form),
 * keeping every other op as it is.
 */
export function inlineLatexToText(delta: DeltaOp[]): {
  delta: DeltaOp[];
  count: number;
} {
  let count = 0;
  const out = delta.map(op => {
    const latex = op.attributes?.latex;
    if (typeof latex !== 'string' || !latex) return op;
    count++;
    const { latex: _drop, ...rest } = op.attributes ?? {};
    const attributes = Object.keys(rest).length ? rest : undefined;
    return attributes
      ? { insert: `$${latex}$`, attributes }
      : { insert: `$${latex}$` };
  });
  return { delta: out, count };
}

/** Plain text of a delta (string inserts only). */
export function deltaText(delta: DeltaOp[] | undefined): string {
  return (delta ?? [])
    .map(op => (typeof op.insert === 'string' ? op.insert : ''))
    .join('');
}

/** Inline attribute names used in a delta, for the report. */
export function deltaAttributes(delta: DeltaOp[]): string[] {
  const names = new Set<string>();
  for (const op of delta) {
    for (const key of Object.keys(op.attributes ?? {})) names.add(key);
  }
  return [...names].sort();
}

// --------------------------------------------------------------- links

/**
 * Absolute links into the old instance (`https://base.droneaid.fr/workspace/
 * <ws>/<doc>`), which S6b must rewrite like `affine://` links.
 */
export function oldHostLinks(markdown: string, hosts: string[]): string[] {
  const found = new Set<string>();
  const hostPattern = hosts.map(h => h.replace(/[.]/g, '\\.')).join('|');
  const re = new RegExp(`https?://(?:${hostPattern})(/[^\\s)"'<>\\]]*)?`, 'g');
  for (const match of markdown.matchAll(re)) found.add(match[0]);
  return [...found].sort();
}

export function affineLinkTargets(markdown: string): string[] {
  const ids = new Set<string>();
  for (const m of markdown.matchAll(/\]\(affine:\/\/([A-Za-z0-9_-]+)\)/g)) {
    ids.add(m[1]);
  }
  return [...ids].sort();
}

// ------------------------------------------------------------- old URLs

export const OLD_HOSTS = ['base.droneaid.fr', 'base.drone-aid.fr'];

export type OldUrl = {
  path: string;
  kind: 'doc' | 'share-legacy' | 'workspace' | 'collection' | 'tag' | 'blob';
  workspaceId: string;
  docId?: string;
  targetId?: string;
  published?: boolean;
  note?: string;
};

const WORKSPACE_SUBPATHS = ['all', 'journals', 'trash', 'collection', 'tag', 'settings'];

/**
 * Every path a user may have bookmarked on the old instance. Query strings
 * (`?mode=page|edgeless`, `?lang=xx`, `?blockIds=`) are not separate entries:
 * a redirect must keep or drop them as a whole (see README).
 */
export function oldUrlInventory(input: {
  workspaces: { id: string }[];
  docs: { workspaceId: string; docId: string; published: boolean }[];
  collections: { workspaceId: string; id: string }[];
  tags: { workspaceId: string; id: string }[];
  blobs: { workspaceId: string; key: string }[];
}): OldUrl[] {
  const urls: OldUrl[] = [];
  for (const ws of input.workspaces) {
    urls.push({ path: `/workspace/${ws.id}`, kind: 'workspace', workspaceId: ws.id });
    for (const sub of WORKSPACE_SUBPATHS) {
      urls.push({ path: `/workspace/${ws.id}/${sub}`, kind: 'workspace', workspaceId: ws.id });
    }
  }
  for (const doc of input.docs) {
    urls.push({
      path: `/workspace/${doc.workspaceId}/${doc.docId}`,
      kind: 'doc',
      workspaceId: doc.workspaceId,
      docId: doc.docId,
      published: doc.published,
    });
    urls.push({
      path: `/share/${doc.workspaceId}/${doc.docId}`,
      kind: 'share-legacy',
      workspaceId: doc.workspaceId,
      docId: doc.docId,
      published: doc.published,
      note: 'legacy alias, redirects to /workspace/<ws>/<doc> keeping the query',
    });
  }
  for (const c of input.collections) {
    urls.push({ path: `/workspace/${c.workspaceId}/collection/${c.id}`, kind: 'collection', workspaceId: c.workspaceId, targetId: c.id });
  }
  for (const t of input.tags) {
    urls.push({ path: `/workspace/${t.workspaceId}/tag/${t.id}`, kind: 'tag', workspaceId: t.workspaceId, targetId: t.id });
  }
  for (const b of input.blobs) {
    urls.push({ path: `/api/workspaces/${b.workspaceId}/blobs/${b.key}`, kind: 'blob', workspaceId: b.workspaceId, targetId: b.key });
  }
  return urls.sort(byKey(u => u.path));
}

// ---------------------------------------------------------- app configs

/**
 * Keys whose values are copied. Everything else (OAuth secrets, signing keys,
 * the Gemini key, SMTP credentials and host) is recorded by key only.
 */
export const APP_CONFIG_VALUE_KEYS = new Set([
  'auth.allowedEmailDomains',
  'flags.allowGuestDemoWorkspace',
  'indexer.enabled',
  'mcp.enabled',
  'translate.enabled',
  'translate.gemini.model',
  'mailer.SMTP.port',
  'mailer.SMTP.sender',
]);

/** Values the restore changed on purpose (affine-selfhost/start-restored.sh). */
export const RESTORE_MODIFIED_KEYS: Record<string, string> = {
  'translate.enabled': 'set to false in the restored copy; production is true (state.md)',
  'mailer.SMTP.host': 'set to 127.0.0.1 in the restored copy; production is smtp.resend.com',
};

export function redactAppConfigs(
  rows: { id: string; value: unknown; updatedAt?: unknown }[]
) {
  return [...rows].sort(byKey(r => r.id)).map(row => {
    const copied = APP_CONFIG_VALUE_KEYS.has(row.id);
    return {
      key: row.id,
      valueCopied: copied,
      ...(copied ? { value: row.value } : {}),
      ...(RESTORE_MODIFIED_KEYS[row.id] ? { restoreNote: RESTORE_MODIFIED_KEYS[row.id] } : {}),
    };
  });
}

// --------------------------------------------------------------- blobs

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/tiff': '.tif',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/zip': '.zip',
  'application/json': '.json',
};

/** Bundle file name of a blob: its key plus an extension from its mime. */
export function blobFileName(key: string, mime: string): string {
  if (!/^[A-Za-z0-9_=+-]+$/.test(key)) {
    throw new Error(`Unexpected blob key ${JSON.stringify(key)}`);
  }
  return key + (MIME_EXT[mime.toLowerCase()] ?? '');
}

// ------------------------------------------------------------- comments

type SnapshotBlock = {
  flavour?: string;
  props?: { text?: { delta?: DeltaOp[] }; title?: { delta?: DeltaOp[] } };
  children?: SnapshotBlock[];
};

/**
 * Plain text of a comment body. AFFiNE stores a BlockSuite page snapshot
 * (`{mode, snapshot: {blocks: {...tree}}}`); one line per text block.
 */
export function commentText(content: unknown): string {
  const lines: string[] = [];
  const walk = (block: SnapshotBlock | undefined) => {
    if (!block || typeof block !== 'object') return;
    const delta = block.props?.text?.delta;
    if (Array.isArray(delta)) lines.push(deltaText(delta));
    for (const child of block.children ?? []) walk(child);
  };
  const root = (content as { snapshot?: { blocks?: SnapshotBlock } })?.snapshot
    ?.blocks;
  walk(root);
  return lines.join('\n').trim();
}

// -------------------------------------------------------------- counts

export function countBy<T>(items: T[], key: (item: T) => string) {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function compareCounts(
  expected: Record<string, number>,
  actual: Record<string, number>
) {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  return keys.map(key => ({
    key,
    expected: expected[key] ?? null,
    actual: actual[key] ?? null,
    ok: expected[key] === actual[key],
  }));
}
