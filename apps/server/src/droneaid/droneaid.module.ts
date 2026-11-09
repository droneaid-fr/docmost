import { Module } from '@nestjs/common';
import { AgentsModule } from './agents/agents.module';
import { McpModule } from './mcp/mcp.module';
import { GoogleAuthModule } from './google-auth/google-auth.module';
import { SignupRulesModule } from './signup-rules/signup-rules.module';

/** Root of every DroneAid server module; imported once by AppModule. */
@Module({
  imports: [AgentsModule, McpModule, GoogleAuthModule, SignupRulesModule],
})
export class DroneaidModule {}
