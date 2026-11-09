/**
 * Loads the AFFiNE fork's own code, so the export reads docs exactly as the
 * fork's MCP tools do (read_document, read_database, list_folders, ...).
 *
 * Only pure modules are imported: the native markdown reader, the database
 * model and the Yjs layout helpers. No Nest app is booted and no server needs
 * to run. `yjs` and `@prisma/client` are resolved from the fork's server
 * package, so the Y.Doc instances we build are the ones the fork's helpers
 * expect (a second yjs copy breaks their `instanceof` checks).
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadFork(serverDir: string) {
  const req = createRequire(join(serverDir, 'package.json'));
  const src = (path: string) => import(pathToFileURL(join(serverDir, 'src', path)).href);

  const Y: typeof import('yjs') = await import(
    pathToFileURL(req.resolve('yjs').replace(/\.cjs$/, '.mjs')).href
  );
  const { PrismaClient } = req('@prisma/client');

  const [blocksuite, preserve, dbModel, dbEdit, dbMarkdown, references, workspaceData, ormTable] =
    await Promise.all([
      src('core/utils/blocksuite.ts'),
      src('core/doc/preserve-blocks.ts'),
      src('plugins/mcp/tools/database-model.ts'),
      src('plugins/mcp/tools/database-edit.ts'),
      src('plugins/mcp/tools/database-markdown.ts'),
      src('plugins/mcp/tools/references.ts'),
      src('plugins/mcp/tools/workspace-data.ts'),
      src('core/doc/orm-table.ts'),
    ]);

  return {
    Y,
    PrismaClient,
    /** Native reader, as DocReader.getDocMarkdown calls it. */
    parseDocToMarkdown: blocksuite.parseDocToMarkdownFromDocSnapshot as (
      workspaceId: string,
      docId: string,
      snapshot: Uint8Array,
      aiEditable?: boolean
    ) => {
      title: string;
      markdown: string;
      knownUnsupportedBlocks: string[];
      unknownBlocks: string[];
    },
    blockSentinel: preserve.blockSentinel as (id: string) => string,
    findDatabases: dbModel.findDatabases as (doc: import('yjs').Doc) => {
      id: string;
      block: import('yjs').Map<unknown>;
      title: string;
    }[],
    columnsOf: dbModel.columnsOf,
    columnKeys: dbModel.columnKeys,
    cellsOf: dbModel.cellsOf,
    childIds: dbModel.childIds as (block: unknown) => string[],
    decodeCell: dbModel.decodeCell,
    readRows: dbEdit.readRows,
    describeColumns: dbEdit.describeColumns,
    databaseMarker: dbMarkdown.databaseMarker as (info: {
      id: string;
      title: string;
      rows: number;
      columns: number;
    }) => string,
    renderReadReferences: references.renderReadReferences as (
      markdown: string,
      workspaceId: string,
      titleOf: (docId: string) => string | undefined
    ) => string,
    listPages: workspaceData.listPages,
    listTags: workspaceData.listTags,
    listCollections: workspaceData.listCollections,
    folderRows: workspaceData.folderRows,
    listOrmRows: ormTable.listOrmRows as (doc: import('yjs').Doc) => Record<string, unknown>[],
  };
}

export type Fork = Awaited<ReturnType<typeof loadFork>>;
