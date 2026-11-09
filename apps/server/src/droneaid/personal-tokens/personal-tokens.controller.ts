import {
  Body,
  Controller,
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
import { PersonalTokenService } from './personal-token.service';
import {
  CreatePersonalTokenDto,
  RevokePersonalTokenDto,
} from './dto/personal-token.dto';

/**
 * The signed-in member's own personal MCP tokens (Settings → Account → MCP
 * tokens). Every route acts on the caller's tokens only; there is no user id
 * parameter. Interactive sessions only (`@RequireSessionAuth`), so neither an
 * API key nor an MCP token can mint more tokens.
 */
@UseGuards(JwtAuthGuard)
@RequireSessionAuth()
@Controller('droneaid/personal-tokens')
export class PersonalTokensController {
  constructor(private readonly service: PersonalTokenService) {}

  @HttpCode(HttpStatus.OK)
  @Post()
  async list(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.service.list(user.id, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(
    @Body() dto: CreatePersonalTokenDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.service.create(
      user.id,
      workspace.id,
      dto.name,
      dto.expiresInDays,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('revoke')
  async revoke(
    @Body() dto: RevokePersonalTokenDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.service.revoke(user.id, workspace.id, dto.tokenId);
  }
}
