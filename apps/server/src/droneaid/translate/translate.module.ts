import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ShareModule } from '../../core/share/share.module';
import { TranslationController } from './translation.controller';
import { TranslationAccess } from './translation.access';
import {
  TranslationProcessor,
  TranslationScheduler,
} from './translation.processor';
import { TranslationProvider } from './translation.provider';
import { TranslationRepo } from './translation.repo';
import { TranslationService } from './translation.service';
import { TranslationWorker } from './translation.worker';
import { DRONEAID_SHARE_TITLES, ShareTitles } from './share-title';
import { TRANSLATE_QUEUE } from './translation.queue';

/**
 * Machine translation of published pages (port of our AFFiNE fork's
 * plugins/translate). Global only so core's ShareSeoController can take the
 * optional DRONEAID_SHARE_TITLES provider without importing this module.
 */
@Global()
@Module({
  imports: [
    ShareModule,
    BullModule.registerQueue({
      name: TRANSLATE_QUEUE,
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: { count: 20 },
        attempts: 1,
      },
    }),
  ],
  controllers: [TranslationController],
  providers: [
    TranslationRepo,
    TranslationProvider,
    TranslationAccess,
    TranslationWorker,
    TranslationProcessor,
    TranslationScheduler,
    TranslationService,
    ShareTitles,
    { provide: DRONEAID_SHARE_TITLES, useExisting: ShareTitles },
  ],
  exports: [DRONEAID_SHARE_TITLES],
})
export class TranslateModule {}
