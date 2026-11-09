import type { McpTool } from './define';
import { documentTools } from './documents';
import { docSearchTool } from './search';
import { listFoldersTool } from './folders';
import { documentWriteTools } from './document-write';
import { folderWriteTools } from './folder-write';
import { imageTools } from './images';
import { databaseTools } from './databases';

/** Every MCP tool. */
export const ALL_TOOLS: McpTool<any>[] = [
  ...documentTools,
  docSearchTool,
  listFoldersTool,
  ...documentWriteTools,
  ...folderWriteTools,
  ...imageTools,
  ...databaseTools,
];
