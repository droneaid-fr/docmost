import Fastify from 'fastify';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorageService } from '@nestjs/throttler';
import { bearerRefusal, McpBodyLimit, MCP_ROUTE_PATH } from './mcp-body-limit';
import { MCP_RATE_LIMIT, McpThrottlerGuard } from './mcp-throttler.guard';

const AGENT = `dmcp_${'a'.repeat(43)}`;
const PERSONAL = `dmcpu_${'p'.repeat(43)}`;

describe('bearerRefusal', () => {
  const checks = {
    isLiveAgentToken: jest.fn(async (t: string) => t === AGENT),
    isLivePersonalToken: jest.fn(async (t: string) => t === PERSONAL),
    isValidJwt: jest.fn(async (t: string) => {
      if (t !== 'good.jwt.sig') throw new Error('bad signature');
      return true;
    }),
  };

  it('refuses a missing or malformed header', async () => {
    for (const header of [undefined, '', 'Basic abc', 'Bearer', 'Bearer a b']) {
      expect(await bearerRefusal(header, checks)).toBe('Bearer token required');
    }
  });

  it('refuses unknown agent tokens and bad JWTs', async () => {
    expect(await bearerRefusal(`Bearer dmcp_${'b'.repeat(43)}`, checks)).toMatch(/Invalid/);
    expect(await bearerRefusal('Bearer forged.jwt.sig', checks)).toMatch(/Invalid/);
  });

  it('checks personal tokens against their own table only', async () => {
    expect(await bearerRefusal(`Bearer ${PERSONAL}`, checks)).toBeNull();
    expect(
      await bearerRefusal(`Bearer dmcpu_${'q'.repeat(43)}`, checks),
    ).toMatch(/Invalid/);
    expect(checks.isLiveAgentToken).not.toHaveBeenCalledWith(
      expect.stringMatching(/^dmcpu_/),
    );
    expect(checks.isValidJwt).not.toHaveBeenCalledWith(
      expect.stringMatching(/^dmcpu_/),
    );
  });

  it('lets live agent tokens and valid JWTs through', async () => {
    expect(await bearerRefusal(`Bearer ${AGENT}`, checks)).toBeNull();
    expect(await bearerRefusal('bearer good.jwt.sig', checks)).toBeNull();
  });
});

describe('McpBodyLimit on a Fastify instance', () => {
  async function app() {
    const fastify = Fastify();
    const parsed: string[] = [];
    fastify.addHook('preParsing', async (req) => {
      parsed.push(req.url);
    });
    new McpBodyLimit(
      { httpAdapter: { getInstance: () => fastify } } as any,
      { isLiveToken: async (t: string) => t === AGENT } as any,
      {
        verifyJwt: async () => {
          throw new Error('nope');
        },
      } as any,
      { isLiveToken: async (t: string) => t === PERSONAL } as any,
    );
    const seen: any[] = [];
    fastify.post(MCP_ROUTE_PATH, async (req: any) => {
      seen.push({ size: JSON.stringify(req.body).length, raw: req.rawBody });
      return { ok: true };
    });
    fastify.post('/api/other', async (req: any) => ({
      size: JSON.stringify(req.body).length,
    }));
    await fastify.ready();
    return { fastify, parsed, seen };
  }
  const big = JSON.stringify({ data: 'x'.repeat(20 * 1024 * 1024) });

  it('refuses an anonymous 20 MB POST before parsing its body', async () => {
    const { fastify, parsed, seen } = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: MCP_ROUTE_PATH,
      headers: { 'content-type': 'application/json' },
      payload: big,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('Bearer token required');
    expect(parsed).toEqual([]);
    expect(seen).toEqual([]);
    await fastify.close();
  });

  it('accepts a 20 MB body with a live token, and drops rawBody', async () => {
    const { fastify, seen } = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: MCP_ROUTE_PATH,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${AGENT}`,
      },
      payload: big,
    });
    expect(res.statusCode).toBe(200);
    expect(seen[0].size).toBeGreaterThan(20 * 1024 * 1024);
    expect(seen[0].raw).toBeUndefined();
    await fastify.close();
  });

  it('leaves other routes alone (1 MiB default limit, no auth gate)', async () => {
    const { fastify } = await app();
    const small = await fastify.inject({
      method: 'POST',
      url: '/api/other',
      payload: { a: 1 },
    });
    expect(small.statusCode).toBe(200);
    const large = await fastify.inject({
      method: 'POST',
      url: '/api/other',
      headers: { 'content-type': 'application/json' },
      payload: big,
    });
    expect(large.statusCode).toBe(413);
    await fastify.close();
  });
});

describe('McpThrottlerGuard', () => {
  it(`allows ${MCP_RATE_LIMIT} requests a minute per token, then 429`, async () => {
    const guard = new McpThrottlerGuard(
      { throttlers: [{ name: 'auth', ttl: 60_000, limit: 10 }] } as any,
      new ThrottlerStorageService(),
      new Reflector(),
    );
    await guard.onModuleInit();
    const headers: Record<string, string> = {};
    const res = { header: jest.fn() };
    class Ctl {
      post() {}
    }
    const context: any = {
      getHandler: () => Ctl.prototype.post,
      getClass: () => Ctl,
      switchToHttp: () => ({
        getRequest: () => ({ headers, ip: '1.2.3.4' }),
        getResponse: () => res,
      }),
    };
    headers.authorization = `Bearer ${AGENT}`;
    for (let i = 0; i < MCP_RATE_LIMIT; i++) {
      await expect(guard.canActivate(context)).resolves.toBe(true);
    }
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ThrottlerException,
    );
    // another token has its own budget; core's `auth` throttler does not apply
    headers.authorization = `Bearer dmcp_${'c'.repeat(43)}`;
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
