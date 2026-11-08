import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { FastifyReply, FastifyRequest } from 'fastify';
import {
  createMcpHandler,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { buildMcpServer } from './mcp-server.factory';
import { McpToolDeps } from './tools/context';
import { ALL_TOOLS } from './tools';
import type { McpPrincipal } from './mcp-auth.guard';
import { MCP_BODY_LIMIT_BYTES } from './mcp-body-limit';

/**
 * Bridges Fastify to the SDK's web-standard handler. Serving is stateless:
 * 2025-era clients (the Hermes agent) go through the SDK's legacy stateless
 * fallback, 2026-era clients through the per-request modern path; both get a
 * fresh McpServer built for the authenticated caller.
 */
@Injectable()
export class McpHttpService implements OnModuleDestroy {
  private readonly logger = new Logger(McpHttpService.name);
  private readonly handler: McpHttpHandler;

  constructor(private readonly deps: McpToolDeps) {
    this.handler = createMcpHandler(
      (reqCtx) =>
        buildMcpServer(
          reqCtx.authInfo?.extra?.principal as McpPrincipal,
          this.deps,
          ALL_TOOLS,
        ),
      {
        legacy: 'stateless',
        responseMode: 'json',
        maxRequestBodySize: MCP_BODY_LIMIT_BYTES,
        onerror: (error) => this.logger.debug(`MCP: ${error.message}`),
      },
    );
  }

  async handle(
    req: FastifyRequest,
    reply: FastifyReply,
    principal: McpPrincipal,
  ): Promise<void> {
    const abort = new AbortController();
    reply.raw.on('close', () => abort.abort());

    const response = await this.handler.fetch(toWebRequest(req, abort.signal), {
      parsedBody: req.method === 'POST' ? req.body : undefined,
      authInfo: {
        token: 'redacted',
        clientId: principal.user.id,
        scopes: [],
        extra: { principal },
      },
    });

    reply.status(response.status);
    response.headers.forEach((value, key) => reply.header(key, value));
    if (!response.body) {
      reply.send();
      return;
    }
    reply.send(Readable.fromWeb(response.body as NodeReadableStream));
  }

  async onModuleDestroy() {
    await this.handler.close();
  }
}

function toWebRequest(req: FastifyRequest, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else headers.set(key, String(value));
  }
  const url = `${req.protocol}://${req.hostname}${req.url}`;
  const hasBody = req.method === 'POST';
  const raw = (req as any).rawBody as Buffer | undefined;
  return new Request(url, {
    method: req.method,
    headers,
    signal,
    body: hasBody
      ? raw
        ? new Uint8Array(raw)
        : JSON.stringify(req.body ?? null)
      : undefined,
  });
}
