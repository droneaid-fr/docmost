import type { McpTool } from './define';
import { documentTools } from './documents';
import { docSearchTool } from './search';
import { listFoldersTool } from './folders';

/**
 * Every MCP tool. S3b adds the write tools (create_document, update_document,
 * update_document_meta, create_folder, upload_image), S4c the database tools.
 */
export const ALL_TOOLS: McpTool<any>[] = [
  ...documentTools,
  docSearchTool,
  listFoldersTool,
];
