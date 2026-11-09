import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { PersonalTokenRepo } from './personal-token.repo';
import { PersonalTokenService } from './personal-token.service';
import { PersonalTokensController } from './personal-tokens.controller';

@Module({
  imports: [AgentsModule],
  controllers: [PersonalTokensController],
  providers: [PersonalTokenRepo, PersonalTokenService],
  exports: [PersonalTokenService],
})
export class PersonalTokensModule {}
