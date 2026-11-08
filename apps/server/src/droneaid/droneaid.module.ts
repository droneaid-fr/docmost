import { Module } from '@nestjs/common';
import { AgentsModule } from './agents/agents.module';
import { McpModule } from './mcp/mcp.module';

/** Root of every DroneAid server module; imported once by AppModule. */
@Module({
  imports: [AgentsModule, McpModule],
})
export class DroneaidModule {}
