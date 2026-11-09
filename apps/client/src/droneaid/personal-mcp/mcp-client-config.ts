import { getAppUrl, getServerAppUrl } from "@/lib/config.ts";

export const MCP_PATH = "/api/droneaid/mcp";
export const MCP_SERVER_NAME = "droneaid-base";

/** `${APP_URL}/api/droneaid/mcp`; falls back to the page's own origin. */
export function mcpEndpointUrl(): string {
  const base = (getServerAppUrl() || getAppUrl()).replace(/\/+$/, "");
  return base + MCP_PATH;
}

/**
 * Example `mcpServers` entry (the JSON shape Claude Desktop/Code, Cursor and
 * most MCP clients read) for a streamable-HTTP server with a bearer token.
 */
export function mcpClientConfigJson(url: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: "http",
          url,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
}

/** The same server added with the Claude Code CLI. */
export function claudeCodeCommand(url: string, token: string): string {
  return `claude mcp add --transport http ${MCP_SERVER_NAME} ${url} --header "Authorization: Bearer ${token}"`;
}
