import type { BundleBlock } from './bundle';

/**
 * Text-level preparation of a bundle `body.md` before the S3b Markdown
 * converter (markdown-in.ts) runs. Pure.
 *
 *  - AFFiNE colour spans (`color: var(--affine-...-yellow)`) get the colour
 *    of Docmost's own text-colour menu, which the server schema keeps as a
 *    colour mark; spans with no recognisable colour lose their colour;
 *  - `<!-- affine-block ... -->` markers become a link line (bookmark,
 *    synced/linked doc, other embeds) or a token paragraph that the importer
 *    replaces with a Docmost node (attachment, YouTube embed);
 *  - `blob://<AFFiNE key>` becomes `blob://<attachment id>`, the form
 *    markdown-in.ts resolves to the uploaded file;
 *  - the canvas text of edgeless docs is appended under "Canvas notes".
 */

export const MIG_TOKEN = 'DRONEAIDMIG';

export type PrepStats = {
  colorSpans: number;
  colorSpansDropped: number;
  markers: Record<string, number>;
  markersDropped: string[];
  missingBlobs: string[];
};

export type PrepContext = {
  /** AFFiNE blob key -> attachment id for this page. */
  attachmentFor: (blobKey: string) => string | null;
  /** AFFiNE doc id -> its title, when the doc is in the bundle. */
  titleOf: (docId: string) => string | null;
};

export type BlockToken = {
  token: string;
  kind: 'attachment' | 'youtube';
  blockId: string;
  attrs: Record<string, string>;
};

/** Docmost's text-colour palette (color-selector.tsx). */
export const TEXT_COLORS: Record<string, string> = {
  blue: '#2563EB',
  green: '#008A00',
  purple: '#9333EA',
  violet: '#9333EA',
  red: '#E00000',
  yellow: '#EAB308',
  orange: '#FFA500',
  pink: '#BA4081',
  magenta: '#BA4081',
  grey: '#A8A29E',
  gray: '#A8A29E',
  teal: '#2563EB',
};

const FENCE = /^[ \t]{0,3}(```|~~~)/;

/** Runs `fn` on every line outside fenced code blocks. */
function mapOutsideFences(markdown: string, fn: (line: string) => string): string {
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
      return fence ? line : fn(line);
    })
    .join('\n');
}

export function mapColor(style: string): string | null {
  const value = /color\s*:\s*([^;]+)/i.exec(style)?.[1]?.trim() ?? '';
  if (/^#[0-9a-f]{3,8}$/i.test(value) || /^rgb/i.test(value)) return value;
  const name = /(blue|green|purple|violet|red|yellow|orange|pink|magenta|grey|gray|teal)/i
    .exec(value)?.[1]
    ?.toLowerCase();
  return name ? TEXT_COLORS[name] : null;
}

/** Decodes the exporter's percent-escapes (`%`, `"`, `--`, newlines). */
function unescapeValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseBlockMarker(
  line: string,
): { id: string; flavour: string; attrs: Record<string, string> } | null {
  const match = /^[ \t]*<!--\s*affine-block\s+(.*?)\s*-->[ \t]*$/.exec(line);
  if (!match) return null;
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z][\w-]*)=(?:"([^"]*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(match[1]))) {
    attrs[m[1]] = unescapeValue(m[2] ?? m[3] ?? '');
  }
  if (!attrs.id || !attrs.flavour) return null;
  const { id, flavour, ...rest } = attrs;
  return { id, flavour, attrs: rest };
}

const linkText = (text: string) =>
  text.replace(/[[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

function linkLine(title: string | null | undefined, url: string): string {
  return `[${linkText(title || url) || url}](${url})`;
}

const affineTarget = (target: string | undefined) =>
  /^affine:\/\/([A-Za-z0-9_-]+)/.exec(target ?? '')?.[1] ?? null;

/** One marker -> Markdown line (or token), given its flavour. */
function markerToMarkdown(
  marker: { id: string; flavour: string; attrs: Record<string, string> },
  ctx: PrepContext,
  tokens: BlockToken[],
): string | null {
  const { flavour, attrs, id } = marker;
  const token = (kind: BlockToken['kind'], a: Record<string, string>) => {
    const value = `${MIG_TOKEN}:${kind}:${id}`;
    tokens.push({ token: value, kind, blockId: id, attrs: a });
    return `\n${value}\n`;
  };
  switch (flavour) {
    case 'affine:attachment':
      return attrs.blob ? token('attachment', attrs) : null;
    case 'affine:embed-youtube':
      return attrs.url ? token('youtube', attrs) : null;
    case 'affine:embed-synced-doc':
    case 'affine:embed-linked-doc': {
      const docId = affineTarget(attrs.target);
      if (!docId) return null;
      const title = ctx.titleOf(docId) ?? attrs.title ?? docId;
      return linkLine(title, `affine://${docId}`);
    }
    default:
      // bookmark, figma, github, loom, iframe, ... -> a plain link
      return attrs.url ? linkLine(attrs.title || attrs.caption, attrs.url) : null;
  }
}

/** Canvas-only embeds of an edgeless doc, as marker-like records. */
export function canvasEmbeds(blocks: BundleBlock[]) {
  const wanted = /^affine:(bookmark|embed-)/;
  return blocks
    .filter((b) => b.handling === 'canvas' && wanted.test(b.flavour))
    .map((b) => ({
      id: b.id,
      flavour: b.flavour,
      attrs: {
        url: String(b.props?.url ?? ''),
        title: String(b.props?.title ?? ''),
        target: b.props?.pageId ? `affine://${b.props.pageId}` : '',
      } as Record<string, string>,
    }))
    .map((m) => {
      for (const k of Object.keys(m.attrs)) if (!m.attrs[k]) delete m.attrs[k];
      return m;
    });
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])(\s+(?:\[[ xX]\]\s+)?)/;

/**
 * The AFFiNE reader writes a LaTeX block inside a list at column 0, which
 * ends the list in Markdown and turns the next (indented) item into a code
 * block. Indent such a `$$` block to the content column of the list item
 * before it, so it stays in that item and the list goes on. Pure.
 */
export function nestMathInLists(markdown: string): string {
  const lines = markdown.split('\n');
  let contentIndent = 0; // of the last list item while in a list, else 0
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const opening = FENCE.exec(line);
    if (opening) {
      if (!fence) fence = opening[1];
      else if (opening[1] === fence) fence = null;
      continue;
    }
    if (fence || !line.trim()) continue;
    const item = LIST_ITEM.exec(line);
    if (item) {
      contentIndent = item[1].length + item[2].length + item[3].length;
      continue;
    }
    if (/^\$\$\s*$/.test(line) && contentIndent > 0) {
      const pad = ' '.repeat(contentIndent);
      lines[i] = pad + line;
      let j = i + 1;
      while (j < lines.length) {
        const closing = /^\$\$\s*$/.test(lines[j]);
        lines[j] = pad + lines[j];
        j++;
        if (closing) break;
      }
      i = j - 1;
      continue;
    }
    if (!/^\s/.test(line)) contentIndent = 0;
  }
  return lines.join('\n');
}

export function prepareMarkdown(
  body: string,
  ctx: PrepContext,
  extra: { edgelessNotes?: string | null; canvasBlocks?: BundleBlock[] } = {},
): { markdown: string; tokens: BlockToken[]; stats: PrepStats; affineLinks: string[] } {
  const tokens: BlockToken[] = [];
  const stats: PrepStats = {
    colorSpans: 0,
    colorSpansDropped: 0,
    markers: {},
    markersDropped: [],
    missingBlobs: [],
  };

  const prepLine = (line: string): string => {
    const marker = parseBlockMarker(line);
    if (marker) {
      stats.markers[marker.flavour] = (stats.markers[marker.flavour] ?? 0) + 1;
      const out = markerToMarkdown(marker, ctx, tokens);
      if (out === null) stats.markersDropped.push(`${marker.flavour} ${marker.id}`);
      return out ?? '';
    }
    return line
      .replace(/<span style="([^"]*)">/g, (_all, style: string) => {
        stats.colorSpans++;
        const color = mapColor(style);
        if (!color) {
          stats.colorSpansDropped++;
          return '<span>';
        }
        return `<span style="color: ${color}">`;
      })
      .replace(/blob:\/\/([A-Za-z0-9_\-=+/]+)/g, (all, key: string) => {
        const id = ctx.attachmentFor(key);
        if (!id) {
          stats.missingBlobs.push(key);
          return all;
        }
        return `blob://${id}`;
      });
  };

  let markdown = nestMathInLists(mapOutsideFences(body ?? '', prepLine));

  const notes = (extra.edgelessNotes ?? '').trim();
  const embeds = canvasEmbeds(extra.canvasBlocks ?? []);
  if (notes || embeds.length) {
    const lines = embeds
      .map((m) => {
        stats.markers[m.flavour] = (stats.markers[m.flavour] ?? 0) + 1;
        const out = markerToMarkdown(m, ctx, tokens);
        if (out === null) stats.markersDropped.push(`${m.flavour} ${m.id}`);
        return out;
      })
      .filter((l): l is string => !!l);
    const appendix = [
      '## Canvas notes',
      notes ? mapOutsideFences(notes, prepLine) : '',
      ...lines,
    ].filter(Boolean);
    markdown = `${markdown.replace(/\s+$/, '')}\n\n${appendix.join('\n\n')}\n`;
  }

  const affineLinks = [
    ...new Set([...markdown.matchAll(/affine:\/\/([A-Za-z0-9_-]+)/g)].map((m) => m[1])),
  ];
  return { markdown, tokens, stats, affineLinks };
}
