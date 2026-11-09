/**
 * Markdown helpers for translation (pure, no I/O), adapted from our AFFiNE
 * fork's `plugins/translate/markdown.ts`.
 *
 * A page is sent as a sequence of Markdown blocks separated by blank lines,
 * one block per text block of the page (blocks.ts). These helpers pack the
 * blocks into chunks small enough for one model call, and check that a
 * translated chunk kept the structure of its source: same number of blocks,
 * and per block the same heading level, the same placeholders and the same
 * link targets. A chunk that fails the check is retried once.
 */

/** Stands for a node Markdown cannot carry (mention, math, status, ...). */
export const PLACEHOLDER = /⟦(\d+)⟧/g;

const HEADING = /^ {0,3}(#{1,6})\s/;
const LINK_TARGET = /\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;
const BLOCK_SEPARATOR = /\n[ \t]*\n+/;

export type BlockShape = {
  heading: number;
  placeholders: string[];
  links: string[];
};

export function shapeOf(block: string): BlockShape {
  const heading = HEADING.exec(block);
  return {
    heading: heading ? heading[1].length : 0,
    placeholders: [...block.matchAll(PLACEHOLDER)].map((m) => m[1]).sort(),
    links: [...block.matchAll(LINK_TARGET)].map((m) => m[1]).sort(),
  };
}

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

export function sameShape(source: string, translated: string): boolean {
  const a = shapeOf(source);
  const b = shapeOf(translated);
  return (
    a.heading === b.heading &&
    sameList(a.placeholders, b.placeholders) &&
    sameList(a.links, b.links)
  );
}

/** A block never contains a blank line, so blocks join and split cleanly. */
export function normalizeBlock(block: string): string {
  return block
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]*\n+/g, '\n')
    .trim();
}

export const joinBlocks = (blocks: string[]) => blocks.join('\n\n');

export function splitBlocks(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(BLOCK_SEPARATOR)
    .map((block) => block.trim())
    .filter(Boolean);
}

/**
 * The translated blocks of a chunk, or null when the output does not have the
 * structure of the source (count, headings, placeholders, link targets).
 */
export function matchBlocks(source: string[], output: string): string[] | null {
  const translated = splitBlocks(output);
  if (translated.length !== source.length) return null;
  return source.every((block, i) => sameShape(block, translated[i]))
    ? translated
    : null;
}

/**
 * Greedily packs consecutive blocks into chunks of at most `maxChars`
 * (joined length). A block is never cut, so one longer than the limit
 * becomes a chunk of its own. Returns the block index ranges.
 */
export function packChunks(blocks: string[], maxChars: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const block of blocks) {
    if (current.length && length + 2 + block.length > maxChars) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    length += (current.length ? 2 : 0) + block.length;
    current.push(block);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

const WRAPPING_FENCE = /^\s*```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```\s*$/;

/** Models sometimes wrap their whole answer in a ```markdown fence. */
export function unwrapFence(output: string): string {
  return output.replace(WRAPPING_FENCE, '$1').trim();
}
