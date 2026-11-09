import * as Y from 'yjs';
import { z } from 'zod';
import {
  DatabaseData,
  DatabaseError,
  findDatabasesInJson,
} from '@docmost/editor-ext';
import { Page } from '@docmost/db/types/entity.types';
import { getProsemirrorContent } from '../../../common/helpers/prosemirror/utils';
import { findDatabases, readDatabaseElement, resolveDatabase } from '../../database';
import type { McpToolContext } from './context';
import {
  defineTool,
  docNotFound,
  errorMessage,
  McpToolResult,
  toolError,
  toolJson,
} from './define';
import {
  addRowsChecked,
  applyColumnOps,
  ColumnOp,
  createFromSpec,
  pickDatabase,
  readView,
  removeRowsChecked,
  RowValues,
  updateRowsChecked,
  WRITABLE_TYPES,
} from './database-ops';
import { withLiveDoc } from './live-doc';
import { editablePage, isRefusal } from './write-access';

/**
 * Database tools, with the names, arguments, replies and all-or-nothing
 * behaviour of our AFFiNE fork's (plugins/mcp/tools/databases.ts), on the
 * S4a block. Writes go through the live collaboration doc (withLiveDoc), so
 * open editors see them at once; reads use the live doc when it is loaded
 * here, else the stored content (the same one read_document uses).
 */

const MAX_COLUMNS = 50;
const MAX_ROWS = 5000;
const MAX_ROWS_PER_CALL = 1000;
const MAX_CELL_CHARS = 10_000;
const READ_LIMIT = 100;
const MAX_READ_LIMIT = 500;

const DOC_ID = z
  .string()
  .min(1)
  .max(100)
  .describe('Page id (UUID) or short slug id of the document holding the database');
const DATABASE_ID = z
  .string()
  .min(1)
  .max(100)
  .optional()
  .describe(
    'Database id (or its title). Needed only when the document has more than one database',
  );

const cellInput = z
  .union([
    z.string().max(MAX_CELL_CHARS),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(z.string().max(200)).max(100),
  ])
  .describe(
    'Text, number, true/false, a list of labels (multi-select), or null to clear',
  );
const rowValues = z
  .record(z.string(), cellInput)
  .refine((values) => Object.keys(values).length <= MAX_COLUMNS, {
    message: `at most ${MAX_COLUMNS} values per row`,
  })
  .describe('Values by column name (or column id)');
const columnType = z.enum(WRITABLE_TYPES);
const columnName = z.string().trim().min(1).max(200);

const VALUE_HELP =
  'Values: text for text and link columns; a number for number; true/false for checkbox; a date as YYYY-MM-DD for date; an option label for select and a list of labels for multi-select (new labels become new options); null clears a cell. Rows and columns are named by column name or id.';
const TYPES = `Types: ${WRITABLE_TYPES.join(', ')} (rich-text is the same as text).`;

/** Runs `fn` on one database of an editable page, in one all-or-nothing write. */
async function editDatabase(
  ctx: McpToolContext,
  docId: string,
  databaseId: string | undefined,
  fn: (doc: Y.Doc, databaseId: string) => Record<string, unknown>,
): Promise<McpToolResult> {
  const page = await editablePage(ctx, docId);
  if (isRefusal(page)) return page.refused;
  try {
    const result = await withLiveDoc(ctx, page.id, (doc) => {
      const { id } = resolveDatabase(doc, databaseId);
      return { databaseId: id, ...fn(doc, id) };
    });
    return toolJson({ success: true, docId, ...result });
  } catch (error) {
    if (error instanceof DatabaseError) {
      return toolError(`Nothing was changed. ${error.message}`);
    }
    return toolError(`Failed to edit the database: ${errorMessage(error)}`);
  }
}

/**
 * The page's databases as editors see them now: from the live doc when this
 * collaboration server has it loaded (an unsaved edit is at most 10-45 s
 * old in `content`), else from the stored content. Never opens a
 * connection, so a read neither loads nor saves the doc.
 */
function pageDatabases(ctx: McpToolContext, page: Page): DatabaseData[] {
  const hocuspocus = (ctx.deps.collaborationGateway as any)?.hocuspocus;
  const live: Y.Doc | undefined = hocuspocus?.documents?.get?.(`page.${page.id}`);
  if (live instanceof Y.Doc) {
    return findDatabases(live).map((ref) => readDatabaseElement(ref.element));
  }
  return findDatabasesInJson(getProsemirrorContent(page.content));
}

export const readDatabaseTool = defineTool({
  name: 'read_database',
  title: 'Read Database',
  description: `Read a database in a document: its columns (id, name, type, select options) and a page of rows, each \`{id, values}\` with values by column name (empty values left out; checkbox values are always true or false). Use the row ids with update_database_rows and remove_database_rows. \`search\` keeps rows where any value contains the text (case-insensitive); \`matchingRows\` counts them. Page with \`offset\`; \`nextOffset\` is set while more rows follow. Without databaseId and with several databases in the document, lists them instead.`,
  access: 'read',
  audience: 'all',
  inputSchema: z
    .object({
      docId: DOC_ID,
      databaseId: DATABASE_ID,
      search: z.string().max(200).optional(),
      offset: z.number().int().min(0).optional().describe('Rows to skip. Default 0'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_READ_LIMIT)
        .optional()
        .describe(`Rows to return. Default ${READ_LIMIT}, at most ${MAX_READ_LIMIT}`),
    })
    .strict(),
  execute: async ({ docId, databaseId, search, offset, limit }, ctx) => {
    const page = await ctx.findReadablePage(docId, { includeContent: true });
    if (!page) return docNotFound(docId);
    try {
      const databases = pageDatabases(ctx, page);
      if (!databaseId && databases.length > 1) {
        return toolJson({
          docId,
          databases: databases.map((db) => ({
            id: db.id,
            title: db.title,
            rows: db.rows.length,
          })),
        });
      }
      const data = pickDatabase(databases, databaseId);
      return toolJson({
        docId,
        ...readView(data, { search, offset, limit: limit ?? READ_LIMIT }),
      });
    } catch (error) {
      if (error instanceof DatabaseError) return toolError(error.message);
      return toolError(`Failed to read the database: ${errorMessage(error)}`);
    }
  },
});

export const createDatabaseTool = defineTool({
  name: 'create_database',
  title: 'Create Database',
  description: `Append a database (a sortable, filterable table) to the end of a document. \`columns\` are column names, or \`{name, type}\` for a typed column (default text). ${TYPES} The first column is the row title. \`rows\` holds one list of values per row, in column order; missing values stay empty. ${VALUE_HELP} Up to ${MAX_ROWS} rows and ${MAX_COLUMNS} columns. All rows are added, or nothing if any value is invalid.`,
  access: 'write',
  audience: 'all',
  inputSchema: z
    .object({
      docId: DOC_ID,
      title: z
        .string()
        .max(200)
        .optional()
        .describe('Database name shown above it. Default: "Database"'),
      columns: z
        .array(
          z.union([
            z.string().trim().max(200),
            z.object({ name: z.string().trim().max(200), type: columnType }).strict(),
          ]),
        )
        .min(1, 'Give at least one column')
        .max(MAX_COLUMNS),
      rows: z.array(z.array(cellInput)).max(MAX_ROWS),
    })
    .strict(),
  execute: async ({ docId, title, columns, rows }, ctx) => {
    const page = await editablePage(ctx, docId);
    if (isRefusal(page)) return page.refused;
    try {
      const result = await withLiveDoc(ctx, page.id, (doc) =>
        createFromSpec(doc, {
          title: title?.trim() || 'Database',
          columns,
          rows,
        }),
      );
      return toolJson({ success: true, docId, ...result });
    } catch (error) {
      if (error instanceof DatabaseError) {
        return toolError(`Nothing was changed. ${error.message}`);
      }
      return toolError(`Failed to create database: ${errorMessage(error)}`);
    }
  },
});

export const addDatabaseRowsTool = defineTool({
  name: 'add_database_rows',
  title: 'Add Database Rows',
  description: `Add rows to the end of a database. Each row is an object of values by column name; columns left out stay empty. ${VALUE_HELP} All rows are added, or none if any value is invalid. Up to ${MAX_ROWS_PER_CALL} rows per call. Returns the new row ids.`,
  access: 'write',
  audience: 'all',
  inputSchema: z
    .object({
      docId: DOC_ID,
      databaseId: DATABASE_ID,
      rows: z.array(rowValues).min(1).max(MAX_ROWS_PER_CALL),
    })
    .strict(),
  execute: async ({ docId, databaseId, rows }, ctx) =>
    editDatabase(ctx, docId, databaseId, (doc, id) => ({
      rowIds: addRowsChecked(doc, id, rows as RowValues[]),
    })),
});

export const updateDatabaseRowsTool = defineTool({
  name: 'update_database_rows',
  title: 'Update Database Rows',
  description: `Change cells of existing rows (row ids from read_database). Only the columns given change. ${VALUE_HELP} All changes apply, or none if any row or value is invalid. Up to ${MAX_ROWS_PER_CALL} rows per call.`,
  access: 'write',
  audience: 'all',
  inputSchema: z
    .object({
      docId: DOC_ID,
      databaseId: DATABASE_ID,
      updates: z
        .array(z.object({ rowId: z.string().min(1), values: rowValues }).strict())
        .min(1)
        .max(MAX_ROWS_PER_CALL),
    })
    .strict(),
  execute: async ({ docId, databaseId, updates }, ctx) =>
    editDatabase(ctx, docId, databaseId, (doc, id) => ({
      updatedRows: updateRowsChecked(
        doc,
        id,
        updates as { rowId: string; values: RowValues }[],
      ),
    })),
});

export const removeDatabaseRowsTool = defineTool({
  name: 'remove_database_rows',
  title: 'Remove Database Rows',
  description: `Remove rows from a database by row id (from read_database). Removes all of them, or none if any id is not a row of the database. Up to ${MAX_ROWS_PER_CALL} rows per call. The page history keeps the previous version.`,
  access: 'write',
  audience: 'all',
  inputSchema: z
    .object({
      docId: DOC_ID,
      databaseId: DATABASE_ID,
      rowIds: z.array(z.string().min(1)).min(1).max(MAX_ROWS_PER_CALL),
    })
    .strict(),
  execute: async ({ docId, databaseId, rowIds }, ctx) =>
    editDatabase(ctx, docId, databaseId, (doc, id) => ({
      removedRows: removeRowsChecked(doc, id, rowIds),
    })),
});

const columnOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), name: columnName, type: columnType }).strict(),
  z
    .object({
      op: z.literal('rename'),
      column: z.string().min(1).describe('Column name or id'),
      name: columnName,
    })
    .strict(),
  z
    .object({
      op: z.literal('remove'),
      column: z.string().min(1).describe('Column name or id'),
    })
    .strict(),
  z
    .object({
      op: z.literal('set_type'),
      column: z.string().min(1).describe('Column name or id'),
      type: columnType,
    })
    .strict(),
]);

export const updateDatabaseColumnsTool = defineTool({
  name: 'update_database_columns',
  title: 'Update Database Columns',
  description: `Change a database's columns. \`ops\` run in order: \`{op:"add", name, type}\` adds a column at the end; \`{op:"rename", column, name}\`; \`{op:"remove", column}\`; \`{op:"set_type", column, type}\` converts the existing values (text to select creates one option per distinct value; values that do not fit the new type are cleared and counted in valuesThatDidNotConvert). ${TYPES} The title column can be renamed, not removed or retyped. All ops apply, or none.`,
  access: 'write',
  audience: 'all',
  inputSchema: z
    .object({
      docId: DOC_ID,
      databaseId: DATABASE_ID,
      ops: z.array(columnOp).min(1).max(MAX_COLUMNS),
    })
    .strict(),
  execute: async ({ docId, databaseId, ops }, ctx) =>
    editDatabase(ctx, docId, databaseId, (doc, id) => ({
      columns: applyColumnOps(doc, id, ops as ColumnOp[]),
    })),
});

export const databaseTools = [
  createDatabaseTool,
  readDatabaseTool,
  addDatabaseRowsTool,
  updateDatabaseRowsTool,
  removeDatabaseRowsTool,
  updateDatabaseColumnsTool,
];
