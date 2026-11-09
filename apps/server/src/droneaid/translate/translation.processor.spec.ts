import { TranslationScheduler } from './translation.processor';
import { KICK_DEBOUNCE_MS, TRANSLATE_KICK_JOB_ID } from './translation.queue';

describe('TranslationScheduler.kick', () => {
  it('debounces: every kick uses one delayed job id', async () => {
    const queue = { add: jest.fn(async () => undefined) };
    const scheduler = new TranslationScheduler(queue as any, { enabled: true } as any);
    await scheduler.kick();
    await scheduler.kick();
    expect(queue.add).toHaveBeenCalledTimes(2);
    for (const call of queue.add.mock.calls as any[]) {
      expect(call[2]).toMatchObject({
        jobId: TRANSLATE_KICK_JOB_ID,
        delay: KICK_DEBOUNCE_MS,
        removeOnFail: true,
      });
    }
  });

  it('does nothing while translation is off', async () => {
    const queue = { add: jest.fn() };
    await new TranslationScheduler(queue as any, { enabled: false } as any).kick();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
