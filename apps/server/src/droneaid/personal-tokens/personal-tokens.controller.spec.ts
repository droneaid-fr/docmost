import { PersonalTokensController } from './personal-tokens.controller';

describe('PersonalTokensController (caller only)', () => {
  const service = {
    list: jest.fn().mockResolvedValue({ allowed: true, tokens: [] }),
    create: jest.fn().mockResolvedValue({ token: 'dmcpu_x', record: {} }),
    revoke: jest.fn().mockResolvedValue({}),
  };
  const controller = new PersonalTokensController(service as any);
  const ws = { id: 'ws-1' } as any;
  const member = { id: 'm-1', role: 'member' } as any;

  it('lets a plain member list, create and revoke, always as themselves', async () => {
    await controller.list(member, ws);
    expect(service.list).toHaveBeenCalledWith('m-1', 'ws-1');

    await controller.create({ name: 'n', expiresInDays: 7 } as any, member, ws);
    expect(service.create).toHaveBeenCalledWith('m-1', 'ws-1', 'n', 7);

    // A userId smuggled into the body is ignored: no route takes one.
    await controller.revoke(
      { tokenId: 't-1', userId: 'someone-else' } as any,
      member,
      ws,
    );
    expect(service.revoke).toHaveBeenCalledWith('m-1', 'ws-1', 't-1');
  });
});

describe('personal token DTOs', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { plainToInstance } = require('class-transformer');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { validate } = require('class-validator');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dtos = require('./dto/personal-token.dto');

  const errors = async (cls: any, body: any) =>
    (await validate(plainToInstance(cls, body))).map((e: any) => e.property);

  it('accepts a name with optional expiry in days', async () => {
    expect(await errors(dtos.CreatePersonalTokenDto, { name: 'laptop' })).toEqual([]);
    expect(
      await errors(dtos.CreatePersonalTokenDto, { name: 'x', expiresInDays: 90 }),
    ).toEqual([]);
  });

  it('refuses a blank or long name and an out-of-range expiry', async () => {
    expect(await errors(dtos.CreatePersonalTokenDto, { name: '   ' })).toEqual(['name']);
    expect(
      await errors(dtos.CreatePersonalTokenDto, { name: 'x'.repeat(101) }),
    ).toEqual(['name']);
    expect(
      await errors(dtos.CreatePersonalTokenDto, { name: 'x', expiresInDays: 0 }),
    ).toEqual(['expiresInDays']);
    expect(
      await errors(dtos.CreatePersonalTokenDto, { name: 'x', expiresInDays: 1.5 }),
    ).toEqual(['expiresInDays']);
  });

  it('requires a UUID token id to revoke', async () => {
    expect(await errors(dtos.RevokePersonalTokenDto, { tokenId: 'nope' })).toEqual([
      'tokenId',
    ]);
  });
});
