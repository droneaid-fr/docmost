import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  MAX_ACTIVE_PERSONAL_TOKENS,
  PERSONAL_TOKEN_TOUCH_INTERVAL_MS,
  PersonalTokenService,
} from './personal-token.service';
import {
  generatePersonalToken,
  hashPersonalToken,
  isPersonalToken,
  isWellFormedPersonalToken,
  personalDisplayPrefix,
  PERSONAL_TOKEN_PREFIX,
} from './personal-token.util';
import {
  generateAgentToken,
  isAgentToken,
} from '../agents/agent-token.util';

const WS = 'ws-1';
const USER = 'user-1';

function makeService(over: Record<string, any> = {}) {
  const repo = {
    lockUser: jest.fn(),
    countActive: jest.fn().mockResolvedValue(0),
    insert: jest.fn(async (row) => ({ id: 'tok-1', ...row, tokenHash: undefined })),
    listForUser: jest.fn().mockResolvedValue([]),
    findByHash: jest.fn(),
    revokeForUser: jest.fn(),
    touch: jest.fn(),
    ...over.repo,
  };
  const userRepo = {
    findById: jest
      .fn()
      .mockResolvedValue({ id: USER, deactivatedAt: null, deletedAt: null }),
    ...over.userRepo,
  };
  const agentService = {
    isAgent: jest.fn().mockResolvedValue(false),
    ...over.agentService,
  };
  // executeTx(db, fn) calls db.transaction().execute(fn)
  const db = { transaction: () => ({ execute: (fn: any) => fn('trx') }) };
  const service = new PersonalTokenService(
    db as any,
    repo as any,
    userRepo as any,
    agentService as any,
  );
  return { service, repo, userRepo, agentService };
}

function row(token: string, extra: Record<string, any> = {}) {
  return {
    id: 'tok-1',
    userId: USER,
    workspaceId: WS,
    tokenHash: hashPersonalToken(token),
    revokedAt: null,
    expiresAt: null,
    lastUsedAt: null,
    ...extra,
  };
}

describe('personal tokens', () => {
  it('are random, prefixed, well formed and never taken for agent tokens', () => {
    const a = generatePersonalToken();
    expect(a).not.toEqual(generatePersonalToken());
    expect(a.startsWith(PERSONAL_TOKEN_PREFIX)).toBe(true);
    expect(isWellFormedPersonalToken(a)).toBe(true);
    expect(isPersonalToken(a)).toBe(true);
    expect(isAgentToken(a)).toBe(false);
    expect(isPersonalToken(generateAgentToken())).toBe(false);
    expect(isWellFormedPersonalToken('dmcpu_short')).toBe(false);
    expect(personalDisplayPrefix(a)).toHaveLength(12);
    expect(hashPersonalToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('PersonalTokenService.create', () => {
  it('stores only the hash and prefix, for the caller, and returns the token once', async () => {
    const { service, repo } = makeService();
    const { token } = await service.create(USER, WS, ' laptop ', 30);
    const stored = repo.insert.mock.calls[0][0];
    expect(stored).toMatchObject({
      userId: USER,
      workspaceId: WS,
      name: 'laptop',
      tokenHash: hashPersonalToken(token),
      tokenPrefix: personalDisplayPrefix(token),
    });
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + 29 * 86_400_000,
    );
    expect(repo.lockUser).toHaveBeenCalledWith(USER, 'trx');
  });

  it('creates a token without expiry when none is given', async () => {
    const { service, repo } = makeService();
    await service.create(USER, WS, 'x');
    expect(repo.insert.mock.calls[0][0].expiresAt).toBeNull();
  });

  it('refuses agent accounts with 403', async () => {
    const { service, repo } = makeService({
      agentService: { isAgent: jest.fn().mockResolvedValue(true) },
    });
    await expect(service.create(USER, WS, 'x')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('enforces the active-token cap', async () => {
    const { service, repo } = makeService({
      repo: {
        countActive: jest.fn().mockResolvedValue(MAX_ACTIVE_PERSONAL_TOKENS),
      },
    });
    await expect(service.create(USER, WS, 'x')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('allows the last token under the cap', async () => {
    const { service, repo } = makeService({
      repo: {
        countActive: jest
          .fn()
          .mockResolvedValue(MAX_ACTIVE_PERSONAL_TOKENS - 1),
      },
    });
    await service.create(USER, WS, 'x');
    expect(repo.insert).toHaveBeenCalled();
  });
});

describe('PersonalTokenService.list and revoke', () => {
  it('lists only the caller\'s tokens', async () => {
    const { service, repo } = makeService();
    const result = await service.list(USER, WS);
    expect(repo.listForUser).toHaveBeenCalledWith(USER, WS);
    expect(result).toMatchObject({ allowed: true, tokens: [] });
  });

  it('tells an agent it is not allowed and lists nothing', async () => {
    const { service, repo } = makeService({
      agentService: { isAgent: jest.fn().mockResolvedValue(true) },
    });
    expect(await service.list(USER, WS)).toMatchObject({
      allowed: false,
      tokens: [],
    });
    expect(repo.listForUser).not.toHaveBeenCalled();
  });

  it('revokes scoped to the caller', async () => {
    const { service, repo } = makeService({
      repo: { revokeForUser: jest.fn().mockResolvedValue({ id: 'tok-1' }) },
    });
    await service.revoke(USER, WS, 'tok-1');
    expect(repo.revokeForUser).toHaveBeenCalledWith('tok-1', USER, WS);
  });

  it("refuses to revoke another user's token (404, nothing changed)", async () => {
    // The repo's WHERE user_id = caller matches no row for someone else's token.
    const { service } = makeService({
      repo: { revokeForUser: jest.fn().mockResolvedValue(undefined) },
    });
    await expect(service.revoke('other-user', WS, 'tok-1')).rejects.toThrow(
      'Active token not found',
    );
  });
});

describe('PersonalTokenService.authenticate', () => {
  it('accepts a valid token and records last use', async () => {
    const token = generatePersonalToken();
    const { service, repo, userRepo } = makeService({
      repo: { findByHash: jest.fn().mockResolvedValue(row(token)) },
    });
    const result = await service.authenticate(token);
    expect(result).toMatchObject({ user: { id: USER }, workspaceId: WS });
    expect(userRepo.findById).toHaveBeenCalledWith(USER, WS);
    expect(repo.touch).toHaveBeenCalledWith('tok-1', expect.any(Date));
  });

  it('throttles last-use writes', async () => {
    const token = generatePersonalToken();
    const recent = new Date(Date.now() - PERSONAL_TOKEN_TOUCH_INTERVAL_MS / 2);
    const { service, repo } = makeService({
      repo: {
        findByHash: jest.fn().mockResolvedValue(row(token, { lastUsedAt: recent })),
      },
    });
    expect(await service.authenticate(token)).not.toBeNull();
    expect(repo.touch).not.toHaveBeenCalled();
  });

  it.each([
    ['revoked', { revokedAt: new Date() }],
    ['expired', { expiresAt: new Date(Date.now() - 1000) }],
  ])('refuses a %s token', async (_label, extra) => {
    const token = generatePersonalToken();
    const { service, repo } = makeService({
      repo: { findByHash: jest.fn().mockResolvedValue(row(token, extra)) },
    });
    expect(await service.authenticate(token)).toBeNull();
    expect(await service.isLiveToken(token)).toBe(false);
    expect(repo.touch).not.toHaveBeenCalled();
  });

  it('refuses an unknown or malformed token without a lookup for malformed', async () => {
    const { service, repo } = makeService({
      repo: { findByHash: jest.fn().mockResolvedValue(undefined) },
    });
    expect(await service.authenticate(generatePersonalToken())).toBeNull();
    repo.findByHash.mockClear();
    expect(await service.authenticate('dmcpu_nope')).toBeNull();
    expect(repo.findByHash).not.toHaveBeenCalled();
  });

  it.each([
    ['deactivated', { deactivatedAt: new Date(), deletedAt: null }],
    ['removed from the workspace', { deactivatedAt: null, deletedAt: new Date() }],
  ])('refuses the token of a %s user', async (_label, state) => {
    const token = generatePersonalToken();
    const { service } = makeService({
      repo: { findByHash: jest.fn().mockResolvedValue(row(token)) },
      userRepo: {
        findById: jest.fn().mockResolvedValue({ id: USER, ...state }),
      },
    });
    expect(await service.authenticate(token)).toBeNull();
  });

  it('refuses when the user is no longer in the token\'s workspace', async () => {
    // findById(userId, workspaceId) finds no row once the user is elsewhere.
    const token = generatePersonalToken();
    const { service } = makeService({
      repo: { findByHash: jest.fn().mockResolvedValue(row(token)) },
      userRepo: { findById: jest.fn().mockResolvedValue(undefined) },
    });
    expect(await service.authenticate(token)).toBeNull();
  });

  it('refuses a token whose user has become an agent account', async () => {
    const token = generatePersonalToken();
    const { service } = makeService({
      repo: { findByHash: jest.fn().mockResolvedValue(row(token)) },
      agentService: { isAgent: jest.fn().mockResolvedValue(true) },
    });
    expect(await service.authenticate(token)).toBeNull();
  });
});
