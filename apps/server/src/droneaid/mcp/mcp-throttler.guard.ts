import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import { extractBearerTokenFromHeader } from '../../common/helpers';

export const MCP_THROTTLER = 'droneaid-mcp';
/**
 * Requests per minute per token. The agent's bursts (a PDF import uploads
 * its figures, then writes the page; a CSV import adds rows in batches) stay
 * well below this; a runaway loop does not.
 */
export const MCP_RATE_LIMIT = 120;
export const MCP_RATE_TTL_MS = 60_000;

/**
 * Core's ThrottlerGuard (same Redis storage and options as ThrottleModule)
 * with one throttler of its own, so core's throttler list stays untouched,
 * counted per bearer token. Runs after McpAuthGuard.
 */
@Injectable()
export class McpThrottlerGuard extends ThrottlerGuard {
  async onModuleInit() {
    await super.onModuleInit();
    this.throttlers = [
      { name: MCP_THROTTLER, ttl: MCP_RATE_TTL_MS, limit: MCP_RATE_LIMIT },
    ];
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    const token = extractBearerTokenFromHeader(req as any);
    if (token) {
      return `mcp:${createHash('sha256').update(token).digest('hex').slice(0, 32)}`;
    }
    return `mcp-ip:${req.ip ?? 'unknown'}`;
  }
}
