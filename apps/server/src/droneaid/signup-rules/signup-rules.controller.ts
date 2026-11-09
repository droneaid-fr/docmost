import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RequireSessionAuth } from '../../common/decorators/require-session-auth.decorator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import WorkspaceAbilityFactory from '../../core/casl/abilities/workspace-ability.factory';
import {
  WorkspaceCaslAction,
  WorkspaceCaslSubject,
} from '../../core/casl/interfaces/workspace-ability.type';
import { readGoogleAuthConfig } from '../google-auth/google-auth.config';
import { SignupRulesService } from './signup-rules.service';
import { GoogleSignupSetting } from './google-signup.setting';
import { SaveSignupRulesDto } from './dto/signup-rules.dto';

/**
 * Admin-only API behind Settings → Sign-up rules. Interactive sessions only.
 *   POST /api/droneaid/signup-rules       -> current state
 *   POST /api/droneaid/signup-rules/save  -> replace the rule list and the Google switch
 */
@UseGuards(JwtAuthGuard)
@RequireSessionAuth()
@Controller('droneaid/signup-rules')
export class SignupRulesController {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly configService: ConfigService,
    private readonly signupRules: SignupRulesService,
    private readonly googleSetting: GoogleSignupSetting,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post()
  async get(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertAdmin(user, workspace);
    return this.state(workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('save')
  async save(
    @Body() dto: SaveSignupRulesDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);
    await this.signupRules.saveRules(
      workspace.id,
      dto.rules,
      dto.allowGoogleSignup,
    );
    return this.state(workspace.id);
  }

  private async state(workspaceId: string) {
    const [rules, allowGoogleSignup, spaces] = await Promise.all([
      this.signupRules.listRules(workspaceId),
      this.googleSetting.isSignupAllowed(workspaceId),
      this.db
        .selectFrom('spaces')
        .select(['id', 'name', 'slug'])
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .orderBy('name', 'asc')
        .execute(),
    ]);
    return {
      rules,
      allowGoogleSignup,
      googleConfigured:
        readGoogleAuthConfig((k) => this.configService.get<string>(k)) !== null,
      spaces,
    };
  }

  private assertAdmin(user: User, workspace: Workspace) {
    const ability = this.workspaceAbility.createForUser(user, workspace);
    if (
      ability.cannot(WorkspaceCaslAction.Manage, WorkspaceCaslSubject.Settings)
    ) {
      throw new ForbiddenException();
    }
  }
}
