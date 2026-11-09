import { Injectable } from '@nestjs/common';
import { TranslationRepo } from './translation.repo';
import { TranslationProvider } from './translation.provider';
import { isTranslationLanguage } from './languages';

/**
 * Injection token for core's ShareSeoController (an optional dependency):
 * the translated title and language of a shared page for `?lang=`.
 */
export const DRONEAID_SHARE_TITLES = 'DRONEAID_SHARE_TITLES';

export interface ShareTitleTranslations {
  translatedTitle(
    pageId: string,
    lang: string | undefined,
  ): Promise<{ lang: string; title: string } | null>;
}

@Injectable()
export class ShareTitles implements ShareTitleTranslations {
  constructor(
    private readonly repo: TranslationRepo,
    private readonly provider: TranslationProvider,
  ) {}

  async translatedTitle(pageId: string, lang: string | undefined) {
    if (!lang || !isTranslationLanguage(lang) || !this.provider.enabled) {
      return null;
    }
    const row = await this.repo.getServed(pageId, lang);
    return row?.title ? { lang, title: row.title } : null;
  }
}
