import { BadRequestException } from '@nestjs/common';
import { SignupRulesService } from './signup-rules.service';

const WS = 'ws-1';
const USER = { id: 'user-1', email: 'Ann@Example.com' };

function build(rules: any[], opts: { spaces?: Record<string, any> } = {}) {
  const spaces = opts.spaces ?? { s1: { id: 's1' }, s2: { id: 's2' } };
  const members = new Set<string>();
  const repo = {
    listByWorkspace: jest.fn().mockResolvedValue(rules),
    insert: jest.fn(),
    update: jest.fn(),
    deleteByIds: jest.fn(),
  };
  const googleSetting = { setSignupAllowed: jest.fn() };
  const spaceRepo = {
    findById: jest.fn(async (id: string) => spaces[id] ?? undefined),
  };
  const spaceMemberRepo = {
    getSpaceMemberByTypeId: jest.fn(async (spaceId: string, { userId }) =>
      members.has(`${spaceId}:${userId}`) ? { spaceId, userId } : undefined,
    ),
  };
  const spaceMemberService = {
    addUserToSpace: jest.fn(async (userId: string, spaceId: string) => {
      members.add(`${spaceId}:${userId}`);
    }),
  };
  // executeTx(db, fn) calls db.transaction().execute(fn)
  const db = {
    transaction: () => ({ execute: (fn: any) => fn('trx') }),
  };
  const service = new SignupRulesService(
    db as any,
    repo as any,
    googleSetting as any,
    spaceRepo as any,
    spaceMemberRepo as any,
    spaceMemberService as any,
  );
  return { service, repo, googleSetting, spaceMemberService, members };
}

const rule = (pattern: string, spaceIds: string[], spaceRole = 'writer', id?: string) => ({
  id: id ?? pattern,
  pattern,
  spaceIds,
  spaceRole,
});

describe('SignupRulesService.applyGrants', () => {
  it('adds the user to every granted space with the strongest role', async () => {
    const { service, spaceMemberService } = build([
      rule('example.com', ['s1', 's2'], 'reader'),
      rule('ann@example.com', ['s1'], 'admin'),
    ]);
    const outcomes = await service.applyGrants(USER, WS);
    expect(outcomes).toEqual([
      { spaceId: 's1', role: 'admin', result: 'added' },
      { spaceId: 's2', role: 'reader', result: 'added' },
    ]);
    expect(spaceMemberService.addUserToSpace).toHaveBeenCalledWith(
      'user-1',
      's1',
      'admin',
      WS,
    );
  });

  it('is idempotent: a second run adds nothing', async () => {
    const { service, spaceMemberService } = build([rule('example.com', ['s1'])]);
    await service.applyGrants(USER, WS);
    const again = await service.applyGrants(USER, WS);
    expect(again).toEqual([
      { spaceId: 's1', role: 'writer', result: 'already_member' },
    ]);
    expect(spaceMemberService.addUserToSpace).toHaveBeenCalledTimes(1);
  });

  it('skips a space that no longer exists and still grants the rest', async () => {
    const { service } = build([rule('example.com', ['gone', 's2'])]);
    expect(await service.applyGrants(USER, WS)).toEqual([
      { spaceId: 'gone', role: 'writer', result: 'space_missing' },
      { spaceId: 's2', role: 'writer', result: 'added' },
    ]);
  });

  it('never throws, even when the insert fails', async () => {
    const { service, spaceMemberService } = build([rule('example.com', ['s1'])]);
    spaceMemberService.addUserToSpace.mockRejectedValueOnce(new Error('boom'));
    await expect(service.applyGrants(USER, WS)).resolves.toEqual([
      { spaceId: 's1', role: 'writer', result: 'failed' },
    ]);
  });

  it('never throws when the rules cannot be loaded', async () => {
    const { service, repo } = build([]);
    repo.listByWorkspace.mockRejectedValueOnce(new Error('db down'));
    await expect(service.applyGrants(USER, WS)).resolves.toEqual([]);
  });

  it('grants nothing when no rule matches', async () => {
    const { service, spaceMemberService } = build([rule('other.org', ['s1'])]);
    expect(await service.applyGrants(USER, WS)).toEqual([]);
    expect(spaceMemberService.addUserToSpace).not.toHaveBeenCalled();
  });
});

describe('SignupRulesService.saveRules', () => {
  it.each(['', '  ', '*@example.com', 'ex*ample.com', '*.'])(
    'refuses %j',
    async (pattern) => {
      const { service, repo } = build([]);
      await expect(
        service.saveRules(WS, [{ pattern, spaceIds: [], spaceRole: 'writer' }], true),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.insert).not.toHaveBeenCalled();
    },
  );

  it('updates kept rules, inserts new ones, deletes missing ones', async () => {
    const existing = [
      rule('a.org', ['s1'], 'writer', 'r1'),
      rule('b.org', [], 'writer', 'r2'),
      rule('c.org', [], 'reader', 'r3'),
    ];
    const { service, repo, googleSetting } = build(existing);
    await service.saveRules(
      WS,
      [
        { id: 'r1', pattern: 'A.org ', spaceIds: ['s1'], spaceRole: 'writer' },
        { id: 'r2', pattern: 'b.org', spaceIds: ['s2', 's2'], spaceRole: 'admin' },
        { pattern: '*.new.org', spaceIds: [], spaceRole: 'reader' },
      ],
      false,
    );
    // r1 unchanged after normalisation: no write
    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith(
      WS,
      'r2',
      { pattern: 'b.org', spaceIds: ['s2'], spaceRole: 'admin' },
      'trx',
    );
    expect(repo.insert).toHaveBeenCalledWith(
      WS,
      { pattern: '*.new.org', spaceIds: [], spaceRole: 'reader' },
      'trx',
    );
    expect(repo.deleteByIds).toHaveBeenCalledWith(WS, ['r3'], 'trx');
    expect(googleSetting.setSignupAllowed).toHaveBeenCalledWith(WS, false, 'trx');
  });
});
