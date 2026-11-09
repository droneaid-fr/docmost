import { Injectable, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { TokenService } from '../../core/auth/services/token.service';
import { JwtType } from '../../core/auth/dto/jwt-payload';
import { AgentService } from '../agents/agent.service';
import { isAgentToken } from '../agents/agent-token.util';

export const MCP_ROUTE_PATH = '/api/droneaid/mcp';

/**
 * 24 MiB: an `upload_image` call (S3b) carries the image as base64 inside a
 * JSON-RPC body, and the agent's PDF importer sends figures up to ~16 MB.
 */
export const MCP_BODY_LIMIT_BYTES = 24 * 1024 * 1024;

/** At most one "refused before body" log line per this interval. */
const REFUSAL_LOG_INTERVAL_MS = 10_000;

export type BearerChecks = {
  isLiveAgentToken: (token: string) => Promise<boolean>;
  isValidJwt: (token: string) => Promise<boolean>;
};

/**
 * Why a request to the MCP route is refused before its body is read, or
 * null to let it through to McpAuthGuard (which does the full check). Only
 * cheap checks: header shape, an agent token's row (one indexed lookup), a
 * JWT's signature and expiry.
 */
export async function bearerRefusal(
  authorization: string | undefined,
  checks: BearerChecks,
): Promise<string | null> {
  const match = /^Bearer[ ]+([^\s]+)$/i.exec((authorization ?? '').trim());
  if (!match) return 'Bearer token required';
  const token = match[1];
  try {
    const ok = isAgentToken(token)
      ? await checks.isLiveAgentToken(token)
      : await checks.isValidJwt(token);
    return ok ? null : 'Invalid or revoked token';
  } catch {
    return 'Invalid or revoked token';
  }
}

/**
 * Fastify settings for the MCP route only, installed through an `onRoute`
 * hook:
 *  - `bodyLimit` 24 MiB instead of Fastify's 1 MiB;
 *  - an `onRequest` hook that refuses a request without a well-formed,
 *    valid `Authorization: Bearer` token before Fastify reads its body, so
 *    an anonymous client cannot make the server buffer 24 MiB;
 *  - a `preHandler` hook that drops `req.rawBody`: `main.ts` turns on
 *    Nest's `rawBody` for every route, so the parser keeps a Buffer copy of
 *    the body beside the parsed JSON; we release it as soon as the body is
 *    parsed (the MCP handler uses the parsed body). Keeping it from being
 *    made at all would mean editing `main.ts`.
 *
 * Why an `onRoute` hook and not a parser: Nest registers the global JSON
 * content-type parser itself during init, and only if nothing has registered
 * one before (`FastifyAdapter.useBodyParser` sets `_isParserRegistered`).
 * Adding our own `application/json` parser would therefore either make Fastify
 * throw ("already present") or silently replace the global parser for every
 * route; the AFFiNE fork hit the Express version of this trap (state.md
 * a0a872d82). Route-level options leave every other route untouched.
 *
 * The hook is added from this provider's constructor: Nest sets the HTTP
 * adapter before instantiating providers and registers routes later, in
 * `app.init()`, so the hook sees our route being added.
 */
@Injectable()
export class McpBodyLimit {
  private readonly logger = new Logger(McpBodyLimit.name);
  private refusedSinceLog = 0;
  private lastLogAt = 0;

  constructor(
    adapterHost: HttpAdapterHost,
    private readonly agentService: AgentService,
    private readonly tokenService: TokenService,
  ) {
    const fastify = adapterHost?.httpAdapter?.getInstance?.();
    if (!fastify?.addHook) {
      this.logger.debug('No HTTP adapter; MCP body limit not installed');
      return;
    }
    const checks: BearerChecks = {
      isLiveAgentToken: (token) => this.agentService.isLiveToken(token),
      isValidJwt: async (token) => {
        await this.tokenService.verifyJwt(token, JwtType.ACCESS);
        return true;
      },
    };
    const gate = async (req: any, reply: any) => {
      const refusal = await bearerRefusal(req.headers?.authorization, checks);
      if (!refusal) return;
      this.logRefusal(refusal, req.headers?.['content-length']);
      // Not reading the body: close the connection rather than drain it.
      reply.header('connection', 'close');
      return reply
        .code(401)
        .send({ message: refusal, error: 'Unauthorized', statusCode: 401 });
    };
    const dropRawBody = async (req: any) => {
      req.rawBody = undefined;
    };
    fastify.addHook('onRoute', (route: any) => {
      if (!isMcpRoute(route.url)) return;
      route.bodyLimit = MCP_BODY_LIMIT_BYTES;
      route.onRequest = [...asArray(route.onRequest), gate];
      route.preHandler = [dropRawBody, ...asArray(route.preHandler)];
    });
  }

  private logRefusal(reason: string, contentLength: unknown) {
    this.refusedSinceLog++;
    const now = Date.now();
    if (now - this.lastLogAt < REFUSAL_LOG_INTERVAL_MS) return;
    this.logger.warn(
      `MCP request refused before reading its body (${reason}; content-length ${contentLength ?? '-'}; ${this.refusedSinceLog} refused since last report)`,
    );
    this.refusedSinceLog = 0;
    this.lastLogAt = now;
  }
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function isMcpRoute(url: string | undefined): boolean {
  return (url ?? '').replace(/\/+$/, '') === MCP_ROUTE_PATH;
}
