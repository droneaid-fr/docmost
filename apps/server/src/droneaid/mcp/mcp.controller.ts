import {
  Controller,
  Delete,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { McpAuthGuard, McpPrincipal } from './mcp-auth.guard';
import { McpHttpService } from './mcp-http.service';
import { McpThrottlerGuard } from './mcp-throttler.guard';

/**
 * Streamable-HTTP MCP endpoint at /api/droneaid/mcp (not /mcp, which upstream
 * excludes from the global prefix for its EE server). GET and DELETE are
 * answered by the SDK (405: serving is stateless). Requests without a valid
 * bearer token are refused before their body is read (McpBodyLimit);
 * authenticated ones are limited to MCP_RATE_LIMIT per minute per token.
 */
@UseGuards(McpAuthGuard, McpThrottlerGuard)
@Controller('droneaid/mcp')
export class McpController {
  constructor(private readonly mcpHttp: McpHttpService) {}

  @SkipTransform()
  @Post()
  async post(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    await this.mcpHttp.handle(req, reply, principalOf(req));
  }

  @SkipTransform()
  @Get()
  async get(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    await this.mcpHttp.handle(req, reply, principalOf(req));
  }

  @SkipTransform()
  @Delete()
  async delete(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    await this.mcpHttp.handle(req, reply, principalOf(req));
  }
}

function principalOf(req: FastifyRequest): McpPrincipal {
  return (req as any).user as McpPrincipal;
}
