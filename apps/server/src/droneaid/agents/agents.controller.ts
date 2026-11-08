import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
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
import { AgentService } from './agent.service';
import {
  CreateAgentDto,
  CreateAgentTokenDto,
  RevokeAgentTokenDto,
} from './dto/agent.dto';

/**
 * Admin-only API behind the "Agents" settings page. Interactive sessions only
 * (`@RequireSessionAuth`), so an API key or another token cannot mint tokens.
 */
@UseGuards(JwtAuthGuard)
@RequireSessionAuth()
@Controller('droneaid/agents')
export class AgentsController {
  constructor(
    private readonly agentService: AgentService,
    private readonly workspaceAbility: WorkspaceAbilityFactory,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post()
  async list(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    this.assertAdmin(user, workspace);
    return this.agentService.listAgents(workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(
    @Body() dto: CreateAgentDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);
    return this.agentService.createAgent(user, workspace, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('tokens/create')
  async createToken(
    @Body() dto: CreateAgentTokenDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);
    return this.agentService.mintToken(
      user.id,
      workspace.id,
      dto.agentUserId,
      dto.name,
      dto.expiresInDays,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('tokens/revoke')
  async revokeToken(
    @Body() dto: RevokeAgentTokenDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    this.assertAdmin(user, workspace);
    return this.agentService.revokeToken(workspace.id, dto.tokenId);
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
