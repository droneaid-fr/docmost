import { Module } from '@nestjs/common';
import { SpaceModule } from '../../core/space/space.module';
import { AgentRepo } from './agent.repo';
import { AgentService } from './agent.service';
import { AgentsController } from './agents.controller';

@Module({
  imports: [SpaceModule],
  controllers: [AgentsController],
  providers: [AgentRepo, AgentService],
  exports: [AgentService],
})
export class AgentsModule {}
