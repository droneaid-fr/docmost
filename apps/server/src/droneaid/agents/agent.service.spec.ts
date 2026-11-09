import { AgentService, TOKEN_TOUCH_INTERVAL_MS } from './agent.service';
import {
  AGENT_TOKEN_PREFIX,
  displayPrefix,
  generateAgentToken,
  hashAgentToken,
  isAgentToken,
  isWellFormedAgentToken,
} from './agent-token.util';

const WS = 'ws-1';
const AGENT_ID = 'agent-1';

function makeService(overrides: Partial<Record<string, any>> = {}) {
  const agentRepo = {
    findTokenByHash: jest.fn(),
    findAgent: jest.fn().mockResolvedValue({
      userId: AGENT_ID,
      workspaceId: WS,
      spaceId: 'space-agent',
    }),
    touchToken: jest.fn(),
    insertToken: jest.fn(async (row) => ({
      id: 'tok-1',
      ...row,
      tokenHash: undefined,
    })),
    revokeToken: jest.fn(),
    findDefaultGroupMembership: jest.fn().mockResolvedValue([]),
    removeFromGroups: jest.fn(),
    listAgents: jest.fn().mockResolvedValue([]),
    listTokens: jest.fn().mockResolvedValue([]),
    ...overrides.agentRepo,
  };
  const userRepo = {
    findById: jest
      .fn()
      .mockResolvedValue({
        id: AGENT_ID,
        deactivatedAt: null,
        deletedAt: null,
      }),
    findByEmail: jest.fn(),
    insertUser: jest.fn(),
    ...overrides.userRepo,
  };
  const service = new AgentService(
    {} as any,
    agentRepo as any,
    userRepo as any,
    {} as any,
    {} as any,
  );
  return { service, agentRepo, userRepo };
}

function tokenRow(token: string, extra: Record<string, any> = {}) {
  return {
    id: 'tok-1',
    agentUserId: AGENT_ID,
    workspaceId: WS,
    tokenHash: hashAgentToken(token),
    revokedAt: null,
    expiresAt: null,
    lastUsedAt: null,
    ...extra,
  };
}

describe('agent tokens', () => {
  it('are random, prefixed and well formed', () => {
    const a = generateAgentToken();
    const b = generateAgentToken();
    expect(a).not.toEqual(b);
    expect(a.startsWith(AGENT_TOKEN_PREFIX)).toBe(true);
    expect(isWellFormedAgentToken(a)).toBe(true);
    expect(isAgentToken(a)).toBe(true);
    expect(isAgentToken('eyJhbGciOi.jwt.value')).toBe(false);
    expect(isWellFormedAgentToken('dmcp_short')).toBe(false);
    expect(displayPrefix(a)).toHaveLength(11);
  });

  it('hash is deterministic sha256 hex and differs from the token', () => {
    const t = generateAgentToken();
    expect(hashAgentToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAgentToken(t)).toEqual(hashAgentToken(t));
    expect(hashAgentToken(t)).not.toContain(t);
  });
});

describe('AgentService token lifecycle', () => {
  it('mint stores only the hash and a display prefix, returns the token once', async () => {
    const { service, agentRepo } = makeService();
    const { token } = await service.mintToken(
      'admin-1',
      WS,
      AGENT_ID,
      ' hermes ',
    );
    const stored = agentRepo.insertToken.mock.calls[0][0];
    expect(stored.tokenHash).toEqual(hashAgentToken(token));
    expect(stored.tokenPrefix).toEqual(displayPrefix(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored.name).toEqual('hermes');
    expect(stored.expiresAt).toBeNull();
  });

  it('mint refuses a user that is not an agent', async () => {
    const { service } = makeService({
      agentRepo: { findAgent: jest.fn().mockResolvedValue(undefined) },
    });
    await expect(service.mintToken('a', WS, 'human', 'x')).rejects.toThrow(
      'Agent not found',
    );
  });

  it('mint sets an expiry when asked', async () => {
    const { service, agentRepo } = makeService();
    await service.mintToken('a', WS, AGENT_ID, 'x', 30);
    const expiresAt: Date = agentRepo.insertToken.mock.calls[0][0].expiresAt;
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
  });

  it('authenticates a valid token and records last use', async () => {
    const token = generateAgentToken();
    const { service, agentRepo } = makeService({
      agentRepo: {
        findTokenByHash: jest.fn().mockResolvedValue(tokenRow(token)),
      },
    });
    const result = await service.authenticate(token);
    expect(result?.user.id).toEqual(AGENT_ID);
    expect(agentRepo.findTokenByHash).toHaveBeenCalledWith(
      hashAgentToken(token),
    );
    expect(agentRepo.touchToken).toHaveBeenCalledWith(
      'tok-1',
      expect.any(Date),
    );
  });

  it('throttles last-use writes', async () => {
    const token = generateAgentToken();
    const recent = new Date(Date.now() - TOKEN_TOUCH_INTERVAL_MS / 2);
    const { service, agentRepo } = makeService({
      agentRepo: {
        findTokenByHash: jest
          .fn()
          .mockResolvedValue(tokenRow(token, { lastUsedAt: recent })),
      },
    });
    expect(await service.authenticate(token)).not.toBeNull();
    expect(agentRepo.touchToken).not.toHaveBeenCalled();
  });

  it.each([
    ['revoked', { revokedAt: new Date() }],
    ['expired', { expiresAt: new Date(Date.now() - 1000) }],
  ])('refuses a %s token', async (_label, extra) => {
    const token = generateAgentToken();
    const { service } = makeService({
      agentRepo: {
        findTokenByHash: jest.fn().mockResolvedValue(tokenRow(token, extra)),
      },
    });
    expect(await service.authenticate(token)).toBeNull();
  });

  it('refuses unknown and malformed tokens without a hash lookup for the latter', async () => {
    const { service, agentRepo } = makeService({
      agentRepo: { findTokenByHash: jest.fn().mockResolvedValue(undefined) },
    });
    expect(await service.authenticate(generateAgentToken())).toBeNull();
    expect(await service.authenticate('dmcp_bad')).toBeNull();
    expect(agentRepo.findTokenByHash).toHaveBeenCalledTimes(1);
  });

  it('refuses the token of a deactivated agent user', async () => {
    const token = generateAgentToken();
    const { service } = makeService({
      agentRepo: {
        findTokenByHash: jest.fn().mockResolvedValue(tokenRow(token)),
      },
      userRepo: {
        findById: jest
          .fn()
          .mockResolvedValue({ id: AGENT_ID, deactivatedAt: new Date() }),
      },
    });
    expect(await service.authenticate(token)).toBeNull();
  });

  it('revoke of an unknown or already revoked token is a 404', async () => {
    const { service } = makeService({
      agentRepo: { revokeToken: jest.fn().mockResolvedValue(undefined) },
    });
    await expect(service.revokeToken(WS, 'tok-x')).rejects.toThrow(
      'Active token not found',
    );
  });
});

describe('AgentService.ensureOutsideDefaultGroup (Everyone trap)', () => {
  it('does nothing when the agent is not in the default group', async () => {
    const { service, agentRepo } = makeService();
    expect(await service.ensureOutsideDefaultGroup(AGENT_ID, WS)).toBe(false);
    expect(agentRepo.removeFromGroups).not.toHaveBeenCalled();
  });

  it('removes the agent from the default group when someone added it', async () => {
    const { service, agentRepo } = makeService({
      agentRepo: {
        findDefaultGroupMembership: jest.fn().mockResolvedValue(['everyone']),
      },
    });
    expect(await service.ensureOutsideDefaultGroup(AGENT_ID, WS)).toBe(true);
    expect(agentRepo.removeFromGroups).toHaveBeenCalledWith(AGENT_ID, [
      'everyone',
    ]);
  });
});

describe('AgentService.createAgent', () => {
  it('creates the user without SignupService (no default group), its space, and a writer membership', async () => {
    const insertUser = jest
      .fn()
      .mockResolvedValue({ id: 'new-agent', name: 'Slavik', email: 'a@x' });
    const createSpace = jest
      .fn()
      .mockResolvedValue({ id: 'sp', name: 'Agent', slug: 'agent' });
    const addUserToSpace = jest.fn();
    const insertAgent = jest.fn().mockResolvedValue({ userId: 'new-agent' });
    const db = { transaction: () => ({ execute: (fn: any) => fn('trx') }) };
    const service = new AgentService(
      db as any,
      { insertAgent } as any,
      { findByEmail: jest.fn(), insertUser } as any,
      { createSpace } as any,
      { addUserToSpace } as any,
    );
    const admin = { id: 'admin' } as any;
    const result = await service.createAgent(admin, { id: WS } as any, {
      name: 'Slavik',
      spaceName: 'Agent',
      spaceSlug: 'agent',
    });
    expect(insertUser.mock.calls[0][0]).toMatchObject({
      role: 'member',
      workspaceId: WS,
      email: 'agent.agent@agents.invalid',
    });
    expect(createSpace).toHaveBeenCalledWith(
      admin,
      WS,
      { name: 'Agent', slug: 'agent' },
      'trx',
    );
    expect(addUserToSpace).toHaveBeenCalledWith(
      'new-agent',
      'sp',
      'writer',
      WS,
      'trx',
    );
    expect(insertAgent.mock.calls[0][0]).toMatchObject({
      userId: 'new-agent',
      spaceId: 'sp',
    });
    expect(result.spaceSlug).toEqual('agent');
  });

  it('binds the agent to an existing space when spaceId is given', async () => {
    const insertUser = jest
      .fn()
      .mockResolvedValue({ id: 'new-agent', name: 'DA', email: 'a@x' });
    const createSpace = jest.fn();
    const addUserToSpace = jest.fn();
    const insertAgent = jest.fn().mockResolvedValue({ userId: 'new-agent' });
    const findById = jest.fn().mockResolvedValue({
      id: 'sp-fr',
      name: 'DroneAid France',
      slug: 'droneaid-france',
      deletedAt: null,
    });
    const db = { transaction: () => ({ execute: (fn: any) => fn('trx') }) };
    const service = new AgentService(
      db as any,
      { insertAgent } as any,
      { findByEmail: jest.fn(), insertUser } as any,
      { createSpace } as any,
      { addUserToSpace } as any,
      { findById } as any,
    );
    const result = await service.createAgent({ id: 'admin' } as any, { id: WS } as any, {
      name: 'DA France agent',
      spaceId: 'sp-fr',
    });
    expect(findById).toHaveBeenCalledWith('sp-fr', WS);
    expect(createSpace).not.toHaveBeenCalled();
    expect(insertUser.mock.calls[0][0].email).toEqual(
      'droneaid-france.agent@agents.invalid',
    );
    expect(addUserToSpace).toHaveBeenCalledWith('new-agent', 'sp-fr', 'writer', WS, 'trx');
    expect(insertAgent.mock.calls[0][0]).toMatchObject({ spaceId: 'sp-fr' });
    expect(result).toMatchObject({ spaceId: 'sp-fr', spaceSlug: 'droneaid-france' });
  });

  it('refuses an unknown or deleted spaceId, and a request with no space at all', async () => {
    const make = (space: any) =>
      new AgentService(
        {} as any,
        {} as any,
        { findByEmail: jest.fn() } as any,
        {} as any,
        {} as any,
        { findById: jest.fn().mockResolvedValue(space) } as any,
      );
    await expect(
      make(null).createAgent({ id: 'a' } as any, { id: WS } as any, { name: 'n', spaceId: 'x' }),
    ).rejects.toThrow('Space not found');
    await expect(
      make({ id: 'x', deletedAt: new Date() }).createAgent({ id: 'a' } as any, { id: WS } as any, {
        name: 'n',
        spaceId: 'x',
      }),
    ).rejects.toThrow('Space not found');
    await expect(
      make(null).createAgent({ id: 'a' } as any, { id: WS } as any, { name: 'n' }),
    ).rejects.toThrow('spaceId or both');
  });

  it('refuses an email that already exists', async () => {
    const { service } = makeService({
      userRepo: { findByEmail: jest.fn().mockResolvedValue({ id: 'x' }) },
    });
    await expect(
      service.createAgent({ id: 'a' } as any, { id: WS } as any, {
        name: 'n',
        email: 'taken@x.fr',
        spaceName: 's',
        spaceSlug: 's1',
      }),
    ).rejects.toThrow('already exists');
  });
});

describe('CreateAgentDto', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { plainToInstance } = require('class-transformer');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { validateSync } = require('class-validator');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { CreateAgentDto } = require('./dto/agent.dto');
  const errors = (body: any) =>
    validateSync(plainToInstance(CreateAgentDto, body)).map((e: any) => e.property);

  it('still accepts the original body (new space)', () => {
    expect(errors({ name: 'Agent', spaceName: 'Agent space', spaceSlug: 'agent' })).toEqual([]);
  });

  it('accepts spaceId without space name and slug', () => {
    expect(
      errors({ name: 'Agent', spaceId: '019a6b8e-1b2c-7d3e-8f40-123456789abc' }),
    ).toEqual([]);
  });

  it('requires name and slug when no spaceId is given', () => {
    expect(errors({ name: 'Agent' })).toEqual(['spaceName', 'spaceSlug']);
    expect(errors({ name: 'Agent', spaceId: 'not-a-uuid' })).toEqual(['spaceId']);
  });
});
