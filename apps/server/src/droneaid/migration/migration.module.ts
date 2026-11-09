import { Module } from '@nestjs/common';
import { AuthModule } from '../../core/auth/auth.module';
import { SpaceModule } from '../../core/space/space.module';
import { PageModule } from '../../core/page/page.module';
import { ShareModule } from '../../core/share/share.module';
import { ImportModule } from '../../integrations/import/import.module';
import { AttachmentService } from '../../core/attachment/services/attachment.service';
import { AgentsModule } from '../agents/agents.module';
import { SignupRulesModule } from '../signup-rules/signup-rules.module';
import { ImportMapRepo } from './import-map.repo';
import { AffineImporter } from './importer.service';
import { ImportVerifier } from './verifier.service';

/**
 * The AFFiNE importer. Loaded only by the import CLI (import-cli.ts), never
 * by the server's AppModule.
 */
@Module({
  imports: [
    AuthModule,
    SpaceModule,
    PageModule,
    ShareModule,
    ImportModule,
    AgentsModule,
    SignupRulesModule,
  ],
  providers: [
    // AttachmentModule does not export its service (same as McpModule).
    AttachmentService,
    ImportMapRepo,
    AffineImporter,
    ImportVerifier,
  ],
  exports: [AffineImporter, ImportVerifier],
})
export class MigrationModule {}
