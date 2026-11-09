import * as fs from 'node:fs';
import { ShareSeoController } from '../../core/share/share-seo.controller';
import { ShareTitles } from './share-title';

const INDEX =
  '<html lang="en"><head><title>Docmost</title><!--meta-tags--></head></html>';

function render(titles: ShareTitles | undefined, lang?: string) {
  jest.spyOn(fs, 'existsSync').mockReturnValue(true);
  jest.spyOn(fs, 'readFileSync').mockReturnValue(INDEX as any);
  const shareService = {
    getSharedPage: jest.fn().mockResolvedValue({
      page: { id: 'p1', title: 'Bonjour' },
      share: { spaceId: 's', searchIndexing: true },
    }),
    isSharingAllowed: jest.fn().mockResolvedValue(true),
  };
  const workspaceRepo = {
    findFirst: jest.fn().mockResolvedValue({ id: 'ws', settings: {} }),
  };
  const env = { isSelfHosted: () => true };
  const controller = new ShareSeoController(
    shareService as any,
    workspaceRepo as any,
    env as any,
    titles,
  );
  let sent = '';
  const res: any = { type: () => res, send: (html: string) => (sent = html) };
  return controller
    .getShare(res, { raw: { headers: {} } } as any, 'k', 'doc-p1', lang)
    .then(() => sent);
}

describe('share page meta tags with ?lang=', () => {
  afterEach(() => jest.restoreAllMocks());

  const titles = () => {
    const repo = {
      getServed: jest.fn(async (_p: string, lang: string) =>
        lang === 'en' ? { title: 'Hello', content: {} } : null,
      ),
    };
    return new ShareTitles(repo as any, { enabled: true } as any);
  };

  it('uses the translated title and language', async () => {
    const html = await render(titles(), 'en');
    expect(html).toContain('<title>Hello</title>');
    expect(html).toContain('og:title" content="Hello"');
    expect(html).toContain('<html lang="en"');
  });

  it('keeps the original for an unknown or untranslated language, or without the module', async () => {
    for (const html of [
      await render(titles(), 'de'),
      await render(titles(), 'xx'),
      await render(undefined, 'en'),
    ]) {
      expect(html).toContain('<title>Bonjour</title>');
    }
  });
});
