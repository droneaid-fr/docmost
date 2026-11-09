import { Module } from '@nestjs/common';
import { SpaceModule } from '../../core/space/space.module';
import { SignupRulesController } from './signup-rules.controller';
import { SignupRulesRepo } from './signup-rules.repo';
import { SignupRulesService } from './signup-rules.service';
import { GoogleSignupSetting } from './google-signup.setting';
import { SignupGrantsListener } from './signup-grants.listener';

@Module({
  imports: [SpaceModule],
  controllers: [SignupRulesController],
  providers: [
    SignupRulesRepo,
    SignupRulesService,
    GoogleSignupSetting,
    SignupGrantsListener,
  ],
  exports: [SignupRulesService, GoogleSignupSetting],
})
export class SignupRulesModule {}
