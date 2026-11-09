import {
  agentReaderWorkspaces,
  planSignupRules,
  planSpaceMembers,
  planUsers,
  reviewGrants,
  spaceRoleFor,
} from './roles';

const user = (email: string, extra: any = {}) => ({
  id: `id-${email}`,
  email,
  name: email,
  registered: true,
  admin: false,
  agentOfWorkspaceId: null,
  memberships: [],
  ...extra,
});

const ws = (members: any[], grants: any[] = [], docs: any[] = []) =>
  ({
    workspace: { id: 'w1', name: 'W1', members, sharing: { memberDefaultDocRole: 'manager' } },
    grants,
    docs,
  }) as any;

describe('planUsers', () => {
  it('maps owner/admin/member, skips agents and unused placeholders', () => {
    const { users, skipped } = planUsers(
      {
        users: [
          user('Filipp@droneaid.fr', { admin: true }),
          user('admin@x.nl', { admin: true }),
          user('m@x.fr'),
          user('agent.w1@agents.local', { agentOfWorkspaceId: 'w1' }),
          user('ghost@x.fr', { registered: false }),
          user('invited@x.fr', { registered: false, memberships: [{ workspaceId: 'w1' }] }),
        ],
        workspaces: [],
      } as any,
      'filipp@droneaid.fr',
    );
    expect(users.map((u) => [u.user.email, u.workspaceRole])).toEqual([
      ['admin@x.nl', 'admin'],
      ['Filipp@droneaid.fr', 'owner'],
      ['invited@x.fr', 'member'],
      ['m@x.fr', 'member'],
    ]);
    expect(skipped.map((s) => s.email)).toEqual(['agent.w1@agents.local', 'ghost@x.fr']);
  });

  it('refuses a bundle without the owner', () => {
    expect(() => planUsers({ users: [user('a@b.c')], workspaces: [] } as any, 'x@y.z')).toThrow('Owner');
  });
});

describe('space roles', () => {
  it('maps AFFiNE roles', () => {
    expect(['owner', 'admin', 'member', 'Collaborator', 'external', 'x'].map(spaceRoleFor)).toEqual([
      'admin', 'admin', 'writer', 'writer', 'reader', null,
    ]);
  });

  it('keeps active human members only', () => {
    const { members, skipped } = planSpaceMembers(
      ws([
        { email: 'O@x', role: 'owner', state: 'active', agent: false },
        { email: 'm@x', role: 'member', state: 'active', agent: false },
        { email: 'p@x', role: 'member', state: 'pending', agent: false },
        { email: 'a@x', role: 'member', state: 'active', agent: true },
      ]),
    );
    expect(members).toEqual([
      { email: 'o@x', role: 'admin', affineRole: 'owner' },
      { email: 'm@x', role: 'writer', affineRole: 'member' },
    ]);
    expect(skipped.map((s) => s.email)).toEqual(['p@x', 'a@x']);
  });
});

describe('reviewGrants', () => {
  const grant = (email: string, role: string, agent = false) => ({
    docId: 'd1',
    docTitle: 'Doc',
    principal: { email, agent, userId: email },
    principalType: 'user',
    role,
  });
  it('flags grants beyond the space role and doc-level narrowing; ignores agents', () => {
    const review = reviewGrants(
      ws(
        [
          { email: 'w@x', role: 'member', state: 'active', agent: false },
          { email: 'r@x', role: 'external', state: 'active', agent: false },
        ],
        [grant('w@x', 'owner'), grant('r@x', 'editor'), grant('out@x', 'reader'), grant('ag@x', 'editor', true)],
        [{ docId: 'd1', title: 'Doc', publish: { memberDefaultRole: 'editor' } }],
      ),
    );
    expect(review.map((r) => [r.email, r.effect])).toEqual([
      ['w@x', 'same'],
      ['r@x', 'widened'],
      ['out@x', 'widened'],
      [null, 'narrowed'],
    ]);
  });
});

describe('agentReaderWorkspaces / planSignupRules', () => {
  it('finds other workspaces where the agent had grants', () => {
    const other = { ...ws([], [{ principal: { email: 'AG@x' } }]), workspace: { id: 'w2', name: 'W2' } };
    expect(agentReaderWorkspaces([ws([]), other], 'ag@x', 'w1')).toEqual([
      { workspaceId: 'w2', name: 'W2', grants: 1 },
    ]);
  });

  it('maps allowlist roles to space roles', () => {
    expect(
      planSignupRules([
        { pattern: 'DroneAid.fr', role: 'Collaborator', workspaces: ['w1', 'w1'] },
        { pattern: 'a@b.pt', role: 'Admin', workspaces: ['w2'] },
        { pattern: 'x@y', role: 'Weird', workspaces: [] },
      ]),
    ).toEqual({
      rules: [
        { pattern: 'droneaid.fr', spaceRole: 'writer', workspaceIds: ['w1'], affineRole: 'Collaborator' },
        { pattern: 'a@b.pt', spaceRole: 'admin', workspaceIds: ['w2'], affineRole: 'Admin' },
      ],
      skipped: [{ pattern: 'x@y', reason: 'unknown role Weird' }],
    });
  });
});
