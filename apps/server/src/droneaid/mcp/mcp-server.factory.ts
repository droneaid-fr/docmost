import { Logger } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/server';
import { McpToolContext, McpToolDeps } from './tools/context';
import {
  errorMessage,
  McpTool,
  toolError,
  toolsForCaller,
} from './tools/define';
import type { McpPrincipal } from './mcp-auth.guard';

export const MCP_SERVER_NAME = 'docmost-droneaid';
export const MCP_SERVER_VERSION = '1.0.0';

const logger = new Logger('DroneaidMcp');

/**
 * One McpServer per HTTP request (stateless serving): it lists only the tools
 * the caller's audience allows and runs each with a fresh McpToolContext.
 */
export function buildMcpServer(
  principal: McpPrincipal,
  deps: McpToolDeps,
  tools: McpTool<any>[],
): McpServer {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
  });
  const ctx = new McpToolContext(principal, deps);

  for (const tool of toolsForCaller(tools, principal.isAgent)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: tool.access === 'read',
          destructiveHint: false,
        },
        _meta: {
          'droneaid/access': tool.access,
          'droneaid/audience': tool.audience,
        },
      },
      async (args: any) => {
        try {
          return await tool.execute(args ?? {}, ctx);
        } catch (error) {
          logger.error(`Tool ${tool.name} failed: ${errorMessage(error)}`);
          return toolError(`Tool ${tool.name} failed: ${errorMessage(error)}`);
        }
      },
    );
  }
  return server;
}
