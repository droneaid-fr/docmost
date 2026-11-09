import { htmlToJson } from '../../collaboration/collaboration.util';
import { GeminiRateLimited } from './gemini';
import {
  backoffDelay,
  MAX_RATE_LIMIT_RETRIES,
  TranslationWorker,
} from './translation.worker';
import { fakeGenerate } from './translate.testing';
import { sourceHash } from './blocks';

const PAGE = {
  id: 'page-1',
  workspaceId: 'ws',
  spaceId: 'space',
  title: 'alpha',
  deletedAt: null,
  updatedAt: new Date('2026-11-09T10:00:00.123Z'),
  content: htmlToJson('<p>alpha beta</p>'),
};

function setup(opts: {
  row?: any;
  page?: any;
  hasShare?: boolean;
  published?: boolean;
  generate?: any;
}) {
  const repo = {
    claimNext: jest
      .fn()
      .mockResolvedValue(
        opts.row === undefined
          ? {
              id: 'r1',
              pageId: PAGE.id,
              lang: 'fr',
              sourceLang: 'en',
              attempts: 0,
            }
          : opts.row,
      ),
    complete: jest.fn(),
    confirm: jest.fn(),
    requeueStale: jest.fn().mockResolvedValue(3),
    fail: jest.fn(),
    postpone: jest.fn(),
    deleteForPage: jest.fn(),
    deleteUnshared: jest.fn().mockResolvedValue(2),
    heartbeat: jest.fn(async () => undefined),
  };
  const pageRepo = {
    findById: jest.fn(async (id: string) =>
      id === PAGE.id ? (opts.page === undefined ? PAGE : opts.page) : undefined,
    ),
  };
  const access = {
    hasShare: jest.fn().mockResolvedValue(opts.hasShare ?? true),
    isPublished: jest.fn().mockResolvedValue(opts.published ?? true),
  };
  const provider = {
    config: () => ({ refreshQuietMinutes: 10 }),
    generator: () =>
      opts.generate === undefined ? fakeGenerate : opts.generate,
  };
  const worker = new TranslationWorker(
    repo as any,
    pageRepo as any,
    access as any,
    provider as any,
  );
  return { worker, repo, access };
}

describe('TranslationWorker', () => {
  it('returns false when nothing is due', async () => {
    const { worker } = setup({ row: null });
    expect(await worker.processNext()).toBe(false);
  });

  it('stores the translated snapshot with the source hash', async () => {
    const { worker, repo } = setup({});
    expect(await worker.processNext()).toBe(true);
    expect(repo.complete).toHaveBeenCalledTimes(1);
    const [id, result] = repo.complete.mock.calls[0];
    expect(id).toBe('r1');
    expect(result.title).toBe('ALFA');
    expect(result.content.content[0].content[0].text).toBe('ALFA BETA');
    expect(result.sourceHash).toBe(sourceHash(PAGE.title, PAGE.content));
    expect(result.sourceUpdatedAt).toEqual(PAGE.updatedAt);
  });

  it('re-translates an edited page with its new text', async () => {
    const { worker, repo } = setup({
      row: { id: 'r1', pageId: PAGE.id, lang: 'fr', sourceLang: 'en', attempts: 0, sourceHash: 'old' },
    });
    await worker.processNext();
    expect(repo.complete.mock.calls[0][1].content.content[0].content[0].text).toBe(
      'ALFA BETA',
    );
  });

  it('skips the model when a save left the text as translated', async () => {
    const generate = jest.fn();
    const { worker, repo } = setup({
      generate,
      row: {
        id: 'r1',
        pageId: PAGE.id,
        lang: 'fr',
        sourceLang: 'en',
        attempts: 0,
        sourceHash: sourceHash(PAGE.title, PAGE.content),
      },
    });
    await worker.processNext();
    expect(generate).not.toHaveBeenCalled();
    expect(repo.complete).not.toHaveBeenCalled();
    expect(repo.confirm).toHaveBeenCalledWith('r1', PAGE.updatedAt);
  });

  it('queues edited pages after the configured quiet period', async () => {
    const { worker, repo } = setup({});
    expect(await worker.requeueEdited()).toBe(3);
    expect(repo.requeueStale).toHaveBeenCalledWith(10);
  });

  it('deletes the translations of a page that is no longer shared', async () => {
    const { worker, repo } = setup({ hasShare: false });
    await worker.processNext();
    expect(repo.deleteForPage).toHaveBeenCalledWith(PAGE.id);
    expect(repo.complete).not.toHaveBeenCalled();
  });

  it('fails clearly when no API key is configured', async () => {
    const { worker, repo } = setup({ generate: null });
    await worker.processNext();
    expect(repo.fail).toHaveBeenCalledWith(
      'r1',
      expect.stringContaining('GEMINI_API_KEY'),
    );
  });

  it('fails when sharing is disabled for the page, without deleting', async () => {
    const { worker, repo } = setup({ published: false });
    await worker.processNext();
    expect(repo.fail).toHaveBeenCalledWith(
      'r1',
      expect.stringContaining('disabled'),
    );
    expect(repo.deleteForPage).not.toHaveBeenCalled();
  });

  it('backs off on 429 up to six times, then fails', async () => {
    const limited = async () => {
      throw new GeminiRateLimited('quota');
    };
    for (let attempts = 0; attempts < MAX_RATE_LIMIT_RETRIES; attempts++) {
      const { worker, repo } = setup({
        generate: limited,
        row: {
          id: 'r1',
          pageId: PAGE.id,
          lang: 'fr',
          sourceLang: 'en',
          attempts,
        },
      });
      const before = Date.now();
      await worker.processNext();
      expect(repo.fail).not.toHaveBeenCalled();
      const until: Date = repo.postpone.mock.calls[0][1];
      expect(until.getTime() - before).toBeGreaterThanOrEqual(
        backoffDelay(attempts) - 5,
      );
    }
    const { worker, repo } = setup({
      generate: limited,
      row: {
        id: 'r1',
        pageId: PAGE.id,
        lang: 'fr',
        sourceLang: 'en',
        attempts: MAX_RATE_LIMIT_RETRIES,
      },
    });
    await worker.processNext();
    expect(repo.postpone).not.toHaveBeenCalled();
    expect(repo.fail).toHaveBeenCalledWith(
      'r1',
      expect.stringContaining('quota'),
    );
  });

  it('doubles the delay from one minute, capped at one hour', () => {
    expect([0, 1, 2, 5, 6, 10].map(backoffDelay)).toEqual([
      60_000, 120_000, 240_000, 1_920_000, 3_600_000, 3_600_000,
    ]);
  });

  it('sweep deletes unshared translations in one statement', async () => {
    const { worker, repo } = setup({});
    expect(await worker.sweep()).toBe(2);
    expect(repo.deleteUnshared).toHaveBeenCalledTimes(1);
  });

  it('beats the heartbeat after every chunk of a long page', async () => {
    const long = {
      ...PAGE,
      content: htmlToJson(
        Array.from({ length: 30 }, (_, i) => `<p>alpha ${'beta '.repeat(40)}${i}</p>`).join(''),
      ),
    };
    const { worker, repo } = setup({ page: long });
    await worker.processNext();
    expect(repo.complete).toHaveBeenCalledTimes(1);
    // ~6 kB of text: more than one 4 kB chunk, one beat each
    expect(repo.heartbeat.mock.calls.length).toBeGreaterThan(1);
    expect(repo.heartbeat).toHaveBeenCalledWith('r1');
  });
});
