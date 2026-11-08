import { z } from 'zod';
import type { McpToolContext } from './context';

export type McpTextContent = { type: 'text'; text: string };
export type McpToolResult = { content: McpTextContent[]; isError?: boolean };

/**
 * `read` tools only read; `write` tools change content (S3b onwards).
 * `all` tools are listed for agents and humans; `human` tools are never
 * listed for an agent (workspace-wide or admin-level actions).
 * Permission itself is always enforced per call with Docmost's own CASL
 * checks (McpToolContext); these two labels only decide what is listed.
 */
export type McpToolAccess = 'read' | 'write';
export type McpToolAudience = 'all' | 'human';

export type McpTool<S extends z.ZodObject = z.ZodObject> = {
  name: string;
  title: string;
  description: string;
  access: McpToolAccess;
  audience: McpToolAudience;
  inputSchema: S;
  execute: (args: z.infer<S>, ctx: McpToolContext) => Promise<McpToolResult>;
};

export function defineTool<S extends z.ZodObject>(
  tool: McpTool<S>,
): McpTool<S> {
  return tool;
}

export function toolText(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

export function toolJson(value: unknown): McpToolResult {
  return toolText(JSON.stringify(value));
}

export function toolError(message: string): McpToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Same reply for "missing" and "not allowed", so ids cannot be probed. */
export function docNotFound(docId: string): McpToolResult {
  return toolError(`Doc with id ${docId} not found.`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

/** Tools the caller may see: humans get all, agents only `all`-audience ones. */
export function toolsForCaller(tools: McpTool[], isAgent: boolean): McpTool[] {
  return tools.filter((tool) => !isAgent || tool.audience === 'all');
}
