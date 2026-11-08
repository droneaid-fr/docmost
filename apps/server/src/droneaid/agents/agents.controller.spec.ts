import { ForbiddenException } from '@nestjs/common';
import WorkspaceAbilityFactory from '../../core/casl/abilities/workspace-ability.factory';
import { AgentsController } from './agents.controller';

describe('AgentsController (admin only)', () => {
  const agentService = {
    listAgents: jest.fn().mockResolvedValue([]),
    createAgent: jest.fn(),
    mintToken: jest.fn().mockResolvedValue({ token: 'dmcp_x', record: {} }),
    revokeToken: jest.fn(),
  };
  const controller = new AgentsController(
    agentService as any,
    new WorkspaceAbilityFactory(),
  );
  const ws = { id: 'ws-1' } as any;

  it.each(['owner', 'admin'])(
    'lets a workspace %s list and mint',
    async (role) => {
      const user = { id: 'u', role } as any;
      await expect(controller.list(user, ws)).resolves.toEqual([]);
      await controller.createToken(
        { agentUserId: 'a', name: 'n' } as any,
        user,
        ws,
      );
      expect(agentService.mintToken).toHaveBeenCalledWith(
        'u',
        'ws-1',
        'a',
        'n',
        undefined,
      );
    },
  );

  it('refuses a plain member on every route', async () => {
    const member = { id: 'm', role: 'member' } as any;
    await expect(controller.list(member, ws)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      controller.create({} as any, member, ws),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.createToken({} as any, member, ws),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.revokeToken({} as any, member, ws),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
