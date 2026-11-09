import { Module } from '@nestjs/common';
import { AuthModule } from '../../core/auth/auth.module';
import { GoogleAuthController } from './google-auth.controller';
import { GoogleAuthService } from './google-auth.service';
import { GoogleOidcClient } from './google-oidc.client';
import { SignupRulesModule } from '../signup-rules/signup-rules.module';

@Module({
  imports: [AuthModule, SignupRulesModule],
  controllers: [GoogleAuthController],
  providers: [GoogleAuthService, GoogleOidcClient],
})
export class GoogleAuthModule {}
