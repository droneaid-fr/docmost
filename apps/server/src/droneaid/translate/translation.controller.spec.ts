import { NotFoundException } from '@nestjs/common';
import { TranslationController } from './translation.controller';

const PAGE: any = { id: 'p', workspaceId: 'ws', spaceId: 's' };
const WS: any = { id: 'ws' };

function setup(
  opts: { enabled?: boolean; served?: string[]; sharingAllowed?: boolean } = {},
) {
  const shareService = {
    getSharedPage: jest
      .fn()
      .mockResolvedValue({ page: PAGE, share: { spaceId: 's' } }),
    isSharingAllowed: jest.fn().mockResolvedValue(opts.sharingAllowed ?? true),
    updatePublicAttachments: jest.fn(async (page: any) => ({
      ...page.content,
      tokenized: true,
    })),
  };
  const repo = {
    languages: jest
      .fn()
      .mockResolvedValue(
        (opts.served ?? ['en']).map((lang) => ({ lang, sourceLang: 'fr' })),
      ),
    translation: jest.fn(async (_p: string, lang: string) => ({
      title: `T-${lang}`,
      content: { type: 'doc' },
    })),
  };
  const provider = { enabled: opts.enabled ?? true };
  const controller = new TranslationController(
    {} as any,
    {} as any,
    repo as any,
    provider as any,
    shareService as any,
  );
  return { controller, shareService, repo };
}

describe('public translation endpoint (?lang=)', () => {
  it('lists languages and serves the asked one with public attachment tokens', async () => {
    const { controller } = setup();
    const out = await controller.shared({ pageId: 'p', lang: 'en' }, WS);
    expect(out.sourceLang).toBe('fr');
    expect(out.languages).toEqual(['en']);
    expect(out.translation).toEqual({
      lang: 'en',
      title: 'T-en',
      content: { type: 'doc', tokenized: true },
    });
  });

  it('falls back to the original for an unknown or untranslated language', async () => {
    const { controller, repo } = setup();
    for (const lang of ['de', 'xx', undefined]) {
      const out = await controller.shared({ pageId: 'p', lang }, WS);
      expect(out.translation).toBeNull();
    }
    expect(repo.translation).not.toHaveBeenCalled();
  });

  it('serves nothing while the feature is off', async () => {
    const { controller } = setup({ enabled: false });
    expect(await controller.shared({ pageId: 'p', lang: 'en' }, WS)).toEqual({
      sourceLang: null,
      languages: [],
      translation: null,
    });
  });

  it('is closed like the share itself when sharing is disabled', async () => {
    const { controller } = setup({ sharingAllowed: false });
    await expect(
      controller.shared({ pageId: 'p', lang: 'en' }, WS),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
