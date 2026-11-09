import type { GenerateText } from './gemini';
import { LANGUAGE_NAMES, type TranslationLanguage } from './languages';
import { joinBlocks, matchBlocks, packChunks, unwrapFence } from './markdown';

/** Keeps each request well inside one model response. */
export const DEFAULT_MAX_CHUNK_CHARS = 4000;
const ATTEMPTS_PER_CHUNK = 2;

export class TranslationStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranslationStructureError';
  }
}

export function systemPrompt(
  from: TranslationLanguage,
  to: TranslationLanguage,
): string {
  return [
    `You translate Markdown from ${LANGUAGE_NAMES[from]} to ${LANGUAGE_NAMES[to]}.`,
    'The input is a sequence of blocks separated by blank lines. Return exactly the same number of blocks, in the same order, separated by blank lines: never merge, split, add or drop a block.',
    'Return only the translated Markdown, with no commentary and no surrounding code fence.',
    'Keep every Markdown construct exactly as it is: heading markers, emphasis, inline code, line breaks and inline HTML tags.',
    'Tokens like ⟦12⟧ stand for content that is not text. Keep every token exactly once, unchanged, at the place it belongs in the translated sentence.',
    'Keep link targets unchanged; translate only the link text.',
    'Do not translate inline code.',
    'Never translate the name "DroneAid".',
  ].join('\n');
}

async function translateChunk(
  blocks: string[],
  system: string,
  generate: GenerateText,
): Promise<string[]> {
  const input = joinBlocks(blocks);
  for (let attempt = 1; attempt <= ATTEMPTS_PER_CHUNK; attempt++) {
    const output = unwrapFence(await generate(system, input));
    const matched = matchBlocks(blocks, output);
    if (matched) return matched;
  }
  throw new TranslationStructureError(
    `The translation changed the document structure twice in a row near: ${input.slice(0, 80)}`,
  );
}

/**
 * Translates Markdown blocks chunk by chunk; the result has one block per
 * source block, in order. Sequential on purpose: Gemini quotas are per minute.
 * `onChunk` runs after each chunk (the worker's heartbeat).
 */
export async function translateBlocks(options: {
  blocks: string[];
  from: TranslationLanguage;
  to: TranslationLanguage;
  generate: GenerateText;
  maxChunkChars?: number;
  onChunk?: () => Promise<void>;
}): Promise<string[]> {
  const system = systemPrompt(options.from, options.to);
  const translated: string[] = [];
  const chunks = packChunks(
    options.blocks,
    options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS,
  );
  for (const chunk of chunks) {
    translated.push(...(await translateChunk(chunk, system, options.generate)));
    await options.onChunk?.();
  }
  return translated;
}
