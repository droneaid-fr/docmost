import { htmlToJson } from '../../collaboration/collaboration.util';
import { sourceHash } from './blocks';
import { ServedTranslations } from './served-translations';

const original = { title: 'alpha', content: htmlToJson('<p>alpha</p>') };
const edited = { title: 'alpha', content: htmlToJson('<p>alpha edited</p>') };
const HASH = sourceHash(original.title, original.content);

function setup(page: any, rows: any[]) {
  const repo = {
    servedCandidates: jest.fn(async (_p: string, lang?: string) =>
      rows.filter((r) => !lang || r.lang === lang),
    ),
    markCurrent: jest.fn(async () => undefined),
  };
  const pageRepo = { findById: jest.fn(async () => ({ id: 'p', ...page })) };
  return {
    served: new ServedTranslations(repo as any, pageRepo as any),
    repo,
    pageRepo,
  };
}

const row = (over: any = {}) => ({
  lang: 'fr',
  sourceLang: 'en',
  title: 'alpha-fr',
  sourceHash: HASH,
  current: true,
  content: { type: 'doc' },
  ...over,
});

describe('ServedTranslations', () => {
  it('serves a translation of an unchanged page without loading the page', async () => {
    const { served, pageRepo } = setup(original, [row()]);
    expect(await served.languages('p')).toEqual([{ lang: 'fr', sourceLang: 'en' }]);
    expect(await served.translation('p', 'fr')).toEqual({
      title: 'alpha-fr',
      content: { type: 'doc' },
    });
    expect(pageRepo.findById).not.toHaveBeenCalled();
  });

  it('takes a translation offline as soon as the page text changes', async () => {
    const { served, repo } = setup(edited, [row({ current: false })]);
    expect(await served.languages('p')).toEqual([]);
    expect(await served.translation('p', 'fr')).toBeNull();
    expect(repo.markCurrent).not.toHaveBeenCalled();
  });

  it('keeps serving after a save that left the text as it was, and marks it current', async () => {
    const { served, repo } = setup(original, [row({ current: false })]);
    expect(await served.translation('p', 'fr')).not.toBeNull();
    expect(repo.markCurrent).toHaveBeenCalledWith('p', HASH);
  });
});
