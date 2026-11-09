import { BadRequestException } from '@nestjs/common';
import { presentRows, TranslationService } from './translation.service';

const row = (over: any = {}) => ({
  id: 'r',
  workspaceId: 'ws',
  pageId: 'p',
  lang: 'fr',
  sourceLang: 'en',
  status: 'ready',
  title: 't',
  sourceHash: 'h1',
  error: null,
  attempts: 0,
  availableAt: new Date(),
  translatedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe('out-of-date detection', () => {
  it('flags a snapshot made from other content', () => {
    const [view] = presentRows([row()], 'h2');
    expect(view.outOfDate).toBe(true);
    expect(view.available).toBe(true);
  });

  it('does not flag a snapshot of the current content', () => {
    expect(presentRows([row()], 'h1')[0].outOfDate).toBe(false);
  });

  it('does not flag a language that was never translated', () => {
    const [view] = presentRows(
      [row({ sourceHash: null, status: 'pending' })],
      'h2',
    );
    expect(view.outOfDate).toBe(false);
    expect(view.available).toBe(false);
  });
});

describe('TranslationService.setLanguages', () => {
  const repo = { setLanguages: jest.fn(), requeue: jest.fn() };
  const scheduler = { kick: jest.fn() };
  const service = new TranslationService(
    repo as any,
    {} as any,
    {} as any,
    {} as any,
    scheduler as any,
  );
  const page: any = { id: 'p', workspaceId: 'ws' };

  beforeEach(() => jest.clearAllMocks());

  it('stores unique targets and kicks the job', async () => {
    await service.setLanguages(page, 'fr', ['en', 'de', 'en']);
    expect(repo.setLanguages).toHaveBeenCalledWith('ws', 'p', 'fr', [
      'en',
      'de',
    ]);
    expect(scheduler.kick).toHaveBeenCalled();
  });

  it('rejects unknown languages and source-as-target', async () => {
    await expect(
      service.setLanguages(page, 'fr', ['xx']),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.setLanguages(page, 'it', ['en']),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.setLanguages(page, 'fr', ['fr']),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.setLanguages).not.toHaveBeenCalled();
  });
});
