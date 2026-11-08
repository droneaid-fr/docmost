import { UnauthorizedException } from '@nestjs/common';
import { AGENT_AUTH_TYPE, McpAuthGuard } from './mcp-auth.guard';
import { generateAgentToken } from '../agents/agent-token.util';

const WS = { id: 'ws-1' };
const AGENT_USER = { id: 'agent-1' };
const HUMAN = { id: 'human-1' };

function ctxFor(
  headers: Record<string, string>,
  extra: Record<string, any> = {},
) {
  const req: any = {
    headers,
    cookies: {},
    raw: { workspaceId: 'ws-1' },
    ...extra,
  };
  return {
    req,
    context: { switchToHttp: () => ({ getRequest: () => req }) } as any,
  };
}

function makeGuard(over: Record<string, any> = {}) {
  const agentService = {
    authenticate: jest.fn().mockResolvedValue({
      agent: { userId: 'agent-1', workspaceId: 'ws-1', spaceId: 'sp-agent' },
      user: AGENT_USER,
      tokenId: 't',
    }),
    ensureOutsideDefaultGroup: jest.fn().mockResolvedValue(false),
    isAgent: jest.fn().mockResolvedValue(false),
    ...over.agentService,
  };
  const tokenService = {
    verifyJwt: jest
      .fn()
      .mockResolvedValue({
        sub: 'human-1',
        workspaceId: 'ws-1',
        type: 'access',
      }),
    ...over.tokenService,
  };
  const strategy = {
    validate: jest
      .fn()
      .mockResolvedValue({ user: HUMAN, workspace: WS, authType: 'access' }),
    ...over.strategy,
  };
  const workspaceRepo = { findById: jest.fn().mockResolvedValue(WS) };
  const moduleRef = { get: jest.fn().mockReturnValue(strategy) };
  const guard = new McpAuthGuard(
    agentService as any,
    tokenService as any,
    workspaceRepo as any,
    moduleRef as any,
  );
  return { guard, agentService, tokenService, strategy };
}

describe('McpAuthGuard', () => {
  it('requires a bearer token and ignores the authToken cookie', async () => {
    const { guard } = makeGuard();
    const { context } = ctxFor({}, { cookies: { authToken: 'jwt' } });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('accepts an agent token and attaches the agent principal', async () => {
    const { guard, tokenService } = makeGuard();
    const { context, req } = ctxFor({
      authorization: `Bearer ${generateAgentToken()}`,
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user).toMatchObject({
      user: AGENT_USER,
      workspace: WS,
      isAgent: true,
      authType: AGENT_AUTH_TYPE,
      agentSpaceId: 'sp-agent',
      skipPermissionCache: false,
    });
    expect(tokenService.verifyJwt).not.toHaveBeenCalled();
  });

  it('refuses a revoked or unknown agent token', async () => {
    const { guard } = makeGuard({
      agentService: { authenticate: jest.fn().mockResolvedValue(null) },
    });
    const { context } = ctxFor({
      authorization: `Bearer ${generateAgentToken()}`,
    });
    await expect(guard.canActivate(context)).rejects.toThrow(
      'Invalid or revoked token',
    );
  });

  it('refuses an agent token of another workspace', async () => {
    const { guard } = makeGuard();
    const { context } = ctxFor(
      { authorization: `Bearer ${generateAgentToken()}` },
      { raw: { workspaceId: 'ws-other' } },
    );
    await expect(guard.canActivate(context)).rejects.toThrow(
      'Workspace does not match',
    );
  });

  it('heals the Everyone membership and skips the permission cache', async () => {
    const { guard } = makeGuard({
      agentService: {
        ensureOutsideDefaultGroup: jest.fn().mockResolvedValue(true),
      },
    });
    const { context, req } = ctxFor({
      authorization: `Bearer ${generateAgentToken()}`,
    });
    await guard.canActivate(context);
    expect(req.user.skipPermissionCache).toBe(true);
  });

  it('accepts a human session JWT through core JwtStrategy.validate', async () => {
    const { guard, strategy, tokenService } = makeGuard();
    const { context, req } = ctxFor({ authorization: 'Bearer eyJ.jwt.sig' });
    await guard.canActivate(context);
    expect(tokenService.verifyJwt).toHaveBeenCalledWith(
      'eyJ.jwt.sig',
      'access',
    );
    expect(strategy.validate).toHaveBeenCalled();
    expect(req.user).toMatchObject({
      user: HUMAN,
      isAgent: false,
      authType: 'access',
    });
  });

  it('refuses an invalid JWT', async () => {
    const { guard } = makeGuard({
      tokenService: {
        verifyJwt: jest.fn().mockRejectedValue(new Error('bad sig')),
      },
    });
    const { context } = ctxFor({ authorization: 'Bearer eyJ.jwt.sig' });
    await expect(guard.canActivate(context)).rejects.toThrow('Invalid token');
  });

  it('refuses a session JWT that belongs to an agent user', async () => {
    const { guard } = makeGuard({
      agentService: { isAgent: jest.fn().mockResolvedValue(true) },
    });
    const { context } = ctxFor({ authorization: 'Bearer eyJ.jwt.sig' });
    await expect(guard.canActivate(context)).rejects.toThrow(
      'Agents must use an agent token',
    );
  });
});
