import { GoogleAuthService } from './google-auth.service';

const WS: any = { id: 'ws-1', emailDomains: [] };
const AGENT = { id: 'agent-user', email: 'agent@droneaid.fr', deactivatedAt: null, deletedAt: null };
const HUMAN = { id: 'human-user', email: 'alice@droneaid.fr', deactivatedAt: null, deletedAt: null };

/** db stand-in: only the droneaid_agents lookup reaches it in these tests. */
function fakeDb(agentUserIds: string[]) {
  const calls: any[] = [];
  const qb: any = {
    selectFrom: (t: string) => (calls.push(['selectFrom', t]), qb),
    select: () => qb,
    where: (...args: any[]) => (calls.push(['where', ...args]), qb),
    execute: async () => agentUserIds.map((userId) => ({ userId })),
  };
  return { qb, calls };
}

function setup(byEmail: any, agentIds: string[]) {
  const { qb, calls } = fakeDb(agentIds);
  const userRepo = {
    findByEmail: jest.fn(async () => byEmail),
    updateLastLogin: jest.fn(),
  };
  const sessionService = { createSessionAndToken: jest.fn(async () => 'tok') };
  const service = new GoogleAuthService(
    qb as any,
    userRepo as any,
    {} as any,
    sessionService as any,
    { log: jest.fn() } as any,
    { isAllowed: jest.fn(async () => false), applyGrants: jest.fn() } as any,
    { getOrCreateProvider: jest.fn(async () => ({ id: 'prov', allowSignup: false })) } as any,
  );
  jest.spyOn(service as any, 'findLinkedUser').mockResolvedValue(null);
  jest.spyOn(service as any, 'findLinkedSub').mockResolvedValue(null);
  const link = jest.spyOn(service as any, 'link').mockResolvedValue(undefined);
  return { service, calls, link, sessionService };
}

const claims = (email: string) => ({ sub: 'g-1', email, email_verified: true });

describe('GoogleAuthService and agent accounts', () => {
  it('refuses an agent found by email, without linking or a session', async () => {
    const { service, calls, link, sessionService } = setup(AGENT, [AGENT.id]);
    const result = await service.signIn(claims(AGENT.email), WS);
    expect(result).toEqual({ ok: false, code: 'account_disabled' });
    expect(calls).toContainEqual(['selectFrom', 'droneaidAgents']);
    expect(calls).toContainEqual(['where', 'userId', 'in', [AGENT.id]]);
    expect(link).not.toHaveBeenCalled();
    expect(sessionService.createSessionAndToken).not.toHaveBeenCalled();
  });

  it('still links and signs in a human found by email', async () => {
    const { service, link } = setup(HUMAN, []);
    const result = await service.signIn(claims(HUMAN.email), WS);
    expect(result).toMatchObject({ ok: true, userId: HUMAN.id });
    expect(link).toHaveBeenCalledWith(HUMAN.id, 'g-1', 'prov', 'ws-1');
  });
});
