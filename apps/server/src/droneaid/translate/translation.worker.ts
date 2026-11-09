import { Injectable, Logger } from '@nestjs/common';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { getProsemirrorContent } from '../../common/helpers/prosemirror/utils';
import { GeminiRateLimited } from './gemini';
import { isTranslationLanguage } from './languages';
import { TranslationProvider } from './translation.provider';
import { TranslationRepo, TranslationSummary } from './translation.repo';
import { TranslationAccess } from './translation.access';
import { translateBlocks } from './translator';
import {
  applyBlocks,
  extractBlocks,
  sourceHash,
  titleBlock,
  titleFromBlock,
} from './blocks';

/** Rate-limit retries before a row is marked failed. */
export const MAX_RATE_LIMIT_RETRIES = 6;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;

/** Delay before retry number `attempts + 1` after a 429. */
export function backoffDelay(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_MAX_MS);
}

/** A page, translated: title and ProseMirror JSON. */
export async function translatePage(options: {
  title: string | null;
  content: any;
  from: Parameters<typeof translateBlocks>[0]['from'];
  to: Parameters<typeof translateBlocks>[0]['to'];
  generate: Parameters<typeof translateBlocks>[0]['generate'];
  maxChunkChars?: number;
}): Promise<{ title: string; content: any }> {
  const title = (options.title ?? '').trim();
  const extracted = extractBlocks(options.content);
  const source = title
    ? [titleBlock(title), ...extracted.blocks]
    : extracted.blocks;
  if (!source.length) return { title, content: options.content };

  const translated = await translateBlocks({
    blocks: source,
    from: options.from,
    to: options.to,
    generate: options.generate,
    maxChunkChars: options.maxChunkChars,
  });
  const body = title ? translated.slice(1) : translated;
  return {
    title: title ? titleFromBlock(translated[0]) || title : '',
    content: await applyBlocks(options.content, extracted, body),
  };
}

@Injectable()
export class TranslationWorker {
  private readonly logger = new Logger(TranslationWorker.name);

  constructor(
    private readonly repo: TranslationRepo,
    private readonly pageRepo: PageRepo,
    private readonly access: TranslationAccess,
    private readonly provider: TranslationProvider,
  ) {}

  /** Deletes the translations of pages that are no longer shared. */
  async sweep(): Promise<number> {
    let removed = 0;
    for (const pageId of await this.repo.pageIds()) {
      const page = await this.pageRepo.findById(pageId);
      if (page && !page.deletedAt && (await this.access.hasShare(page))) {
        continue;
      }
      await this.repo.deleteForPage(pageId);
      removed++;
    }
    return removed;
  }

  /** Handles one due translation. False when nothing is due. */
  async processNext(): Promise<boolean> {
    const row = await this.repo.claimNext();
    if (!row) return false;

    try {
      await this.translate(row);
    } catch (error) {
      if (
        error instanceof GeminiRateLimited &&
        row.attempts < MAX_RATE_LIMIT_RETRIES
      ) {
        await this.repo.postpone(
          row.id,
          new Date(Date.now() + backoffDelay(row.attempts)),
        );
        return true;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Translation of page ${row.pageId} to ${row.lang} failed: ${message}`,
      );
      await this.repo.fail(row.id, message);
    }
    return true;
  }

  private async translate(row: TranslationSummary): Promise<void> {
    const page = await this.pageRepo.findById(row.pageId, {
      includeContent: true,
    });
    if (!page || page.deletedAt || !(await this.access.hasShare(page))) {
      await this.repo.deleteForPage(row.pageId);
      return;
    }
    if (!(await this.access.isPublished(page))) {
      throw new Error('Public sharing of this page is disabled or restricted.');
    }
    const generate = this.provider.generator();
    if (!generate) {
      throw new Error(
        'Translation is not configured: set GEMINI_API_KEY in the server environment.',
      );
    }
    const { lang, sourceLang } = row;
    if (!isTranslationLanguage(lang) || !isTranslationLanguage(sourceLang)) {
      throw new Error(`Unsupported language pair ${sourceLang} -> ${lang}.`);
    }

    const content = getProsemirrorContent(page.content);
    const hash = sourceHash(page.title, content);
    const result = await translatePage({
      title: page.title,
      content,
      from: sourceLang,
      to: lang,
      generate,
    });
    await this.repo.complete(row.id, {
      title: result.title,
      content: result.content,
      sourceHash: hash,
    });
  }
}
