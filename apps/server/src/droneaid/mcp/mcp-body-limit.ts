import { Injectable, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

export const MCP_ROUTE_PATH = '/api/droneaid/mcp';

/**
 * 24 MiB: an `upload_image` call (S3b) carries the image as base64 inside a
 * JSON-RPC body, and the agent's PDF importer sends figures up to ~16 MB.
 */
export const MCP_BODY_LIMIT_BYTES = 24 * 1024 * 1024;

/**
 * Raises Fastify's body limit (1 MiB by default) for the MCP route only.
 *
 * Why an `onRoute` hook and not a parser: Nest registers the global JSON
 * content-type parser itself during init, and only if nothing has registered
 * one before (`FastifyAdapter.useBodyParser` sets `_isParserRegistered`).
 * Adding our own `application/json` parser would therefore either make Fastify
 * throw ("already present") or silently replace the global parser for every
 * route; the AFFiNE fork hit the Express version of this trap (state.md
 * a0a872d82). A route-level `bodyLimit` overrides the parser's limit for this
 * route alone and leaves the global parser untouched.
 *
 * The hook is added from this provider's constructor: Nest sets the HTTP
 * adapter before instantiating providers and registers routes later, in
 * `app.init()`, so the hook sees our route being added.
 */
@Injectable()
export class McpBodyLimit {
  private readonly logger = new Logger(McpBodyLimit.name);

  constructor(adapterHost: HttpAdapterHost) {
    const fastify = adapterHost?.httpAdapter?.getInstance?.();
    if (!fastify?.addHook) {
      this.logger.debug('No HTTP adapter; MCP body limit not installed');
      return;
    }
    fastify.addHook('onRoute', (route: any) => {
      if (isMcpRoute(route.url)) route.bodyLimit = MCP_BODY_LIMIT_BYTES;
    });
  }
}

export function isMcpRoute(url: string | undefined): boolean {
  return (url ?? '').replace(/\/+$/, '') === MCP_ROUTE_PATH;
}
