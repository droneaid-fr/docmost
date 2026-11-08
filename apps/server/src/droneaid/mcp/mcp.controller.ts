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

/**
 * Streamable-HTTP MCP endpoint at /api/droneaid/mcp (not /mcp, which upstream
 * excludes from the global prefix for its EE server). GET and DELETE are
 * answered by the SDK (405: serving is stateless).
 */
@UseGuards(McpAuthGuard)
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
