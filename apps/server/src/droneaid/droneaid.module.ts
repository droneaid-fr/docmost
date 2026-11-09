import { Module } from '@nestjs/common';
import { AgentsModule } from './agents/agents.module';
import { McpModule } from './mcp/mcp.module';
import { PersonalTokensModule } from './personal-tokens/personal-tokens.module';
import { GoogleAuthModule } from './google-auth/google-auth.module';
import { SignupRulesModule } from './signup-rules/signup-rules.module';
import { TranslateModule } from './translate/translate.module';

/** Root of every DroneAid server module; imported once by AppModule. */
@Module({
  imports: [
    AgentsModule,
    McpModule,
    PersonalTokensModule,
    GoogleAuthModule,
    SignupRulesModule,
    TranslateModule,
  ],
})
export class DroneaidModule {}
