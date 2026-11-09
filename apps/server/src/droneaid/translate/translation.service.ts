import { BadRequestException, Injectable } from '@nestjs/common';
import { Page, User } from '@docmost/db/types/entity.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { getProsemirrorContent } from '../../common/helpers/prosemirror/utils';
import { isTranslationLanguage, TRANSLATION_LANGUAGES } from './languages';
import { TranslationRepo, TranslationSummary } from './translation.repo';
import { TranslationAccess } from './translation.access';
import { TranslationProvider } from './translation.provider';
import { TranslationScheduler } from './translation.processor';
import { sourceHash } from './blocks';

export type TranslationView = {
  lang: string;
  sourceLang: string;
  status: string;
  error: string | null;
  translatedAt: Date | null;
  /** A snapshot exists (served only while not out of date). */
  available: boolean;
  /**
   * The page changed after the snapshot was made: readers see the original
   * until it is translated again.
   */
  outOfDate: boolean;
};

export type PageTranslationsView = {
  enabled: boolean;
  canManage: boolean;
  published: boolean;
  languages: readonly string[];
  sourceLang: string | null;
  translations: TranslationView[];
  /** Edited pages are translated again after this many minutes without edits. */
  refreshQuietMinutes: number;
};

/** Out of date: a snapshot exists and was made from other content. */
export function presentRows(
  rows: TranslationSummary[],
  currentHash: string,
): TranslationView[] {
  return rows.map((row) => ({
    lang: row.lang,
    sourceLang: row.sourceLang,
    status: row.status,
    error: row.error,
    translatedAt: row.translatedAt as Date | null,
    available: !!row.sourceHash,
    outOfDate: !!row.sourceHash && row.sourceHash !== currentHash,
  }));
}

@Injectable()
export class TranslationService {
  constructor(
    private readonly repo: TranslationRepo,
    private readonly pageRepo: PageRepo,
    private readonly access: TranslationAccess,
    private readonly provider: TranslationProvider,
    private readonly scheduler: TranslationScheduler,
  ) {}

  async view(page: Page, user: User): Promise<PageTranslationsView> {
    const enabled = this.provider.enabled;
    const [canManage, published] = await Promise.all([
      this.access.canManage(page, user),
      this.access.isPublished(page),
    ]);
    const rows = enabled ? await this.repo.list(page.id) : [];
    let translations: TranslationView[] = [];
    if (rows.length) {
      const withContent = await this.pageRepo.findById(page.id, {
        includeContent: true,
      });
      const hash = sourceHash(
        withContent.title,
        getProsemirrorContent(withContent.content),
      );
      translations = presentRows(rows, hash);
    }
    return {
      enabled,
      canManage,
      published,
      languages: TRANSLATION_LANGUAGES,
      sourceLang: rows[0]?.sourceLang ?? null,
      translations,
      refreshQuietMinutes: this.provider.config().refreshQuietMinutes,
    };
  }

  async setLanguages(
    page: Page,
    sourceLang: string,
    languages: string[],
  ): Promise<void> {
    const targets = [...new Set(languages)];
    for (const lang of [sourceLang, ...targets]) {
      if (!isTranslationLanguage(lang)) {
        throw new BadRequestException(`Unsupported language: ${lang}`);
      }
    }
    if (targets.includes(sourceLang)) {
      throw new BadRequestException(
        'The source language cannot also be a target.',
      );
    }
    await this.repo.setLanguages(
      page.workspaceId,
      page.id,
      sourceLang,
      targets,
    );
    await this.scheduler.kick();
  }

  async update(page: Page): Promise<void> {
    await this.repo.requeue(page.id);
    await this.scheduler.kick();
  }
}
