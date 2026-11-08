import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { FastifyRequest } from 'fastify';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { TokenService } from '../../core/auth/services/token.service';
import { JwtStrategy } from '../../core/auth/strategies/jwt.strategy';
import { JwtType } from '../../core/auth/dto/jwt-payload';
import { extractBearerTokenFromHeader } from '../../common/helpers';
import { AgentService } from '../agents/agent.service';
import { isAgentToken } from '../agents/agent-token.util';

export const AGENT_AUTH_TYPE = 'droneaid_agent';

export type McpPrincipal = {
  user: User;
  workspace: Workspace;
  authType: typeof AGENT_AUTH_TYPE | JwtType.ACCESS;
  isAgent: boolean;
  /** The agent's own space (writer), when the caller is an agent. */
  agentSpaceId?: string | null;
  /** Set when the default-group heal ran: skip the 5 s permission cache. */
  skipPermissionCache?: boolean;
};

/**
 * Authenticates the MCP route, and only that route. Accepts
 * `Authorization: Bearer <token>` where the token is either
 *  - an agent token (`dmcp_...`, checked against droneaid_agent_tokens), or
 *  - a human session JWT (`type: access`), validated by core's own
 *    JwtStrategy (workspace match, disabled user, active session).
 * The `authToken` cookie is ignored on purpose: MCP clients send a header,
 * and cookie auth would expose the endpoint to cross-site requests.
 */
@Injectable()
export class McpAuthGuard implements CanActivate {
  private readonly logger = new Logger(McpAuthGuard.name);

  constructor(
    private readonly agentService: AgentService,
    private readonly tokenService: TokenService,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly moduleRef: ModuleRef,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest & any>();
    const token = extractBearerTokenFromHeader(req);
    if (!token) throw new UnauthorizedException('Bearer token required');

    const principal = isAgentToken(token)
      ? await this.authenticateAgent(token, req)
      : await this.authenticateHuman(token, req);

    req.user = principal;
    return true;
  }

  private async authenticateAgent(
    token: string,
    req: any,
  ): Promise<McpPrincipal> {
    const result = await this.agentService.authenticate(token);
    if (!result) throw new UnauthorizedException('Invalid or revoked token');

    const workspaceId = result.agent.workspaceId;
    if (req.raw?.workspaceId && req.raw.workspaceId !== workspaceId) {
      throw new UnauthorizedException('Workspace does not match');
    }
    const workspace = await this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new UnauthorizedException();

    const healed = await this.agentService.ensureOutsideDefaultGroup(
      result.user.id,
      workspaceId,
    );

    return {
      user: result.user,
      workspace,
      authType: AGENT_AUTH_TYPE,
      isAgent: true,
      agentSpaceId: result.agent.spaceId,
      skipPermissionCache: healed,
    };
  }

  private async authenticateHuman(
    token: string,
    req: any,
  ): Promise<McpPrincipal> {
    let payload: any;
    try {
      payload = await this.tokenService.verifyJwt(token, JwtType.ACCESS);
    } catch {
      throw new UnauthorizedException('Invalid token');
    }

    // Core's own checks: workspace, user disabled, session still active.
    const strategy = this.moduleRef.get(JwtStrategy, { strict: false });
    const { user, workspace } = await strategy.validate(req, payload);

    if (await this.agentService.isAgent(user.id, workspace.id)) {
      this.logger.warn(`Agent ${user.id} presented a session JWT; refused`);
      throw new UnauthorizedException('Agents must use an agent token');
    }

    return { user, workspace, authType: JwtType.ACCESS, isAgent: false };
  }
}
