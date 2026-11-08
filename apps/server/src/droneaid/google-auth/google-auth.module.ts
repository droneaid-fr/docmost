import { Module } from '@nestjs/common';
import { AuthModule } from '../../core/auth/auth.module';
import { GoogleAuthController } from './google-auth.controller';
import { GoogleAuthService } from './google-auth.service';
import { GoogleOidcClient } from './google-oidc.client';

@Module({
  imports: [AuthModule],
  controllers: [GoogleAuthController],
  providers: [GoogleAuthService, GoogleOidcClient],
})
export class GoogleAuthModule {}
