import {
  InjectQueue,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { TranslationProvider } from './translation.provider';
import { TranslationWorker } from './translation.worker';
import {
  KICK_DEBOUNCE_MS,
  TICK_BUDGET_MS,
  TRANSLATE_KICK_JOB_ID,
  TRANSLATE_QUEUE,
  TRANSLATE_SCHEDULER_ID,
  TRANSLATE_TICK_JOB,
  TRANSLATE_TICK_MS,
} from './translation.queue';

/**
 * The translation job: a BullMQ job scheduler fires a tick every 30 s (only
 * while TRANSLATE_ENABLED); each tick drops translations of pages that are no
 * longer shared, queues again the translations of pages edited and then left
 * alone for TRANSLATE_REFRESH_QUIET_MINUTES, then translates due rows one
 * language at a time until its time budget is spent. Saving languages or pressing Update queues an extra
 * tick so the user does not wait for the next slot.
 */
@Processor(TRANSLATE_QUEUE)
export class TranslationProcessor extends WorkerHost {
  private readonly logger = new Logger(TranslationProcessor.name);

  constructor(
    private readonly provider: TranslationProvider,
    private readonly translations: TranslationWorker,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== TRANSLATE_TICK_JOB || !this.provider.enabled) return;
    await this.translations.sweep();
    await this.translations.requeueEdited();
    const deadline = Date.now() + TICK_BUDGET_MS;
    while (Date.now() < deadline && (await this.translations.processNext())) {
      // one row per iteration; Gemini quotas are per minute
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error): void {
    this.logger.error(`Translation tick ${job?.id} failed: ${err.message}`);
  }
}

@Injectable()
export class TranslationScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(TranslationScheduler.name);

  constructor(
    @InjectQueue(TRANSLATE_QUEUE) private readonly queue: Queue,
    private readonly provider: TranslationProvider,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      if (this.provider.enabled) {
        await this.queue.upsertJobScheduler(
          TRANSLATE_SCHEDULER_ID,
          { every: TRANSLATE_TICK_MS },
          { name: TRANSLATE_TICK_JOB, data: {} },
        );
      } else {
        await this.queue.removeJobScheduler(TRANSLATE_SCHEDULER_ID);
      }
    } catch (err) {
      this.logger.error(`Could not set up the translation scheduler: ${err}`);
    }
  }

  /**
   * Runs a tick soon, outside the 30 s rhythm. Debounced: while a kick is
   * waiting, further kicks add nothing (same job id), so a burst of saves
   * costs one tick.
   */
  async kick(): Promise<void> {
    if (!this.provider.enabled) return;
    try {
      await this.queue.add(
        TRANSLATE_TICK_JOB,
        {},
        {
          jobId: TRANSLATE_KICK_JOB_ID,
          delay: KICK_DEBOUNCE_MS,
          // A kept failed job would swallow every later kick (same id).
          removeOnFail: true,
        },
      );
    } catch (err) {
      this.logger.warn(`Could not queue a translation tick: ${err}`);
    }
  }
}
