import { Injectable, Logger } from '@nestjs/common';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { getProsemirrorContent } from '../../common/helpers/prosemirror/utils';
import { sourceHash } from './blocks';
import { ServedCandidate, TranslationRepo } from './translation.repo';

/**
 * The translations readers may see: only snapshots made from the page's
 * current text. After an edit the original is shown until the job has
 * translated the page again (automatically after a quiet period, or at once
 * with Update). Used by the public route, the language menu and the SEO
 * title, so all three agree.
 */
@Injectable()
export class ServedTranslations {
  private readonly logger = new Logger(ServedTranslations.name);

  constructor(
    private readonly repo: TranslationRepo,
    private readonly pageRepo: PageRepo,
  ) {}

  /** Languages a reader can switch to right now, with the source language. */
  async languages(
    pageId: string,
  ): Promise<{ lang: string; sourceLang: string }[]> {
    const rows = await this.current(
      pageId,
      await this.repo.servedCandidates(pageId),
    );
    return rows.map(({ lang, sourceLang }) => ({ lang, sourceLang }));
  }

  /** One current translation, or null (then the original is shown). */
  async translation(
    pageId: string,
    lang: string,
  ): Promise<{ title: string | null; content: any } | null> {
    const [row] = await this.current(
      pageId,
      await this.repo.servedCandidates(pageId, lang),
    );
    return row ? { title: row.title, content: row.content } : null;
  }

  /**
   * Rows known current by timestamp pass at once. The others (the page was
   * saved since) pass only when their hash equals the page's current hash;
   * those are then marked current so the next read is cheap again.
   */
  private async current(
    pageId: string,
    rows: ServedCandidate[],
  ): Promise<ServedCandidate[]> {
    if (rows.every((row) => row.current)) return rows;
    const page = await this.pageRepo.findById(pageId, {
      includeContent: true,
    });
    if (!page) return [];
    const hash = sourceHash(page.title, getProsemirrorContent(page.content));
    const kept = rows.filter((row) => row.current || row.sourceHash === hash);
    if (kept.some((row) => !row.current)) {
      await this.repo.markCurrent(pageId, hash).catch((err) => {
        this.logger.warn(`Could not mark translations current: ${err}`);
      });
    }
    return kept;
  }
}
