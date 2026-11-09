import { z } from 'zod';
import { CreatePageDto } from '../../../core/page/dto/create-page.dto';
import { UpdatePageDto } from '../../../core/page/dto/update-page.dto';
import {
  defineTool,
  errorMessage,
  McpTool,
  toolError,
  toolJson,
} from './define';
import {
  composeWithKept,
  dropTokens,
  ignoredRegionEdits,
  KeptReport,
  restoreImageAttrs,
} from './keep-blocks';
import { preserveUnchanged } from './preserve-blocks';
import { liveJson, replaceFragment, withLiveDoc } from './live-doc';
import {
  claimAttachments,
  markdownToDoc,
  queueBacklinks,
} from './markdown-in';
import {
  cleanTitle,
  editablePage,
  isRefusal,
  notifyTree,
  resolveCreateTarget,
} from './write-access';

const DOC_ID = z
  .string()
  .min(1)
  .max(100)
  .describe('Page id (UUID) or short slug id, as returned by the other tools');

/** Same bound as the MCP route body (24 MiB) leaves room for. */
const MAX_MARKDOWN = 5_000_000;

const PAGE_LINK_HINT =
  'Link to another page with `[Title](<page URL>)` (the URL from list_documents or read_document); with the exact page title as text it becomes a page mention, otherwise an internal link.';
const IMAGE_HINT =
  'Images: upload with upload_image, then use the `markdown` it returns (or `![alt](blob://<key>)`).';

const TITLE = z.string().min(1).max(255);

export const createDocumentTool = defineTool({
  name: 'create_document',
  title: 'Create Document',
  description: `Create a new document (a page) from a title and markdown. Returns its docId and link. ${PAGE_LINK_HINT} ${IMAGE_HINT} Placement: folder_id = the parent page (see list_folders); otherwise the top of space_id; otherwise the top of your own space. You get edit rights wherever you can create.`,
  access: 'write',
  audience: 'all',
  inputSchema: z
    .object({
      title: TITLE.describe('The title of the new document'),
      content: z
        .string()
        .max(MAX_MARKDOWN)
        .describe('The markdown body (a leading `# <title>` is dropped)'),
      folder_id: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe('Parent page to file the document under (list_folders)'),
      space_id: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe('Space id, slug or name; defaults to your own space'),
    })
    .strict(),
  execute: async ({ title, content, folder_id, space_id }, ctx) => {
    const target = await resolveCreateTarget(ctx, {
      spaceId: space_id,
      parentId: folder_id,
    });
    if (isRefusal(target)) return target.refused;
    const pageTitle = cleanTitle(title);
    if (!pageTitle) return toolError('Title is empty.');

    try {
      const parsed = await markdownToDoc(ctx, content, { title: pageTitle });
      const body = dropTokens(parsed.json);
      const page = await ctx.deps.pageService.create(
        ctx.user.id,
        ctx.workspace.id,
        {
          title: pageTitle,
          spaceId: target.space.id,
          parentPageId: target.parent?.id,
          content: body,
          format: 'json',
        } as CreatePageDto,
      );
      await claimAttachments(ctx, parsed.attachmentIds, page);
      if (parsed.linkedPages.length) await queueBacklinks(ctx, page, body);
      await notifyTree(ctx, page, 'structure');
      return toolJson({
        success: true,
        docId: page.id,
        slugId: page.slugId,
        title: page.title,
        link: ctx.pageLink(page, target.space.slug),
        url: ctx.pageUrl(page, target.space.slug),
        spaceId: target.space.id,
        folderId: target.parent?.id ?? null,
        linkedPages: parsed.linkedPages,
        ...(parsed.warnings.length ? { warnings: parsed.warnings } : {}),
        message: `Document "${page.title}" created successfully`,
      });
    } catch (error) {
      return toolError(`Failed to create document: ${errorMessage(error)}`);
    }
  },
});

export const updateDocumentTool = defineTool({
  name: 'update_document',
  title: 'Update Document',
  description: `Replace a document body with new markdown; the title stays unless you pass title. Unchanged blocks keep their identity, and people editing the page see the change live. ${PAGE_LINK_HINT} ${IMAGE_HINT} Databases are never edited here: a \`<!-- database id=... -->\` line (as read_document shows it) keeps that database at that spot, and a database whose line is missing is kept at the end. Synced blocks, columns and tabs are kept as they are in the same way: read_document shows each between a \`<!-- <kind> id=... start ... -->\` and a \`<!-- <kind> id=... end -->\` line; keep those two lines where the block should stay; text you change between them is ignored (warned), and a block whose lines are missing is kept at the end. Files, videos, embeds, page breaks and diagrams are kept too: where a line links to them, else after the paragraph they followed, else at the end. Comments, alignment, colours and status badges stay on every paragraph whose text you leave as it is; \`warnings\` lists comments and formatting your rewrites removed. Edit databases with the database tools.`,
  access: 'write',
  audience: 'all',
  inputSchema: z
    .object({
      docId: DOC_ID,
      content: z
        .string()
        .max(MAX_MARKDOWN)
        .describe(
          'The complete new markdown body (a leading `# <title>` repeating the title is dropped)',
        ),
      title: TITLE.optional().describe('New title (optional)'),
    })
    .strict(),
  execute: async ({ docId, content, title }, ctx) => {
    const page = await editablePage(ctx, docId);
    if (isRefusal(page)) return page.refused;
    const newTitle = title === undefined ? undefined : cleanTitle(title);
    if (newTitle === '') return toolError('Title is empty.');

    try {
      const parsed = await markdownToDoc(ctx, content, {
        title: newTitle ?? page.title,
      });
      const base = ctx.baseUrl;
      let kept: KeptReport[] = [];
      const warnings = [...parsed.warnings];
      await withLiveDoc(ctx, page.id, (doc) => {
        const current = liveJson(doc);
        const composed = composeWithKept(current, parsed.json, base);
        const preserved = preserveUnchanged(
          current,
          restoreImageAttrs(current, composed.doc, base),
        );
        replaceFragment(doc, preserved.doc);
        kept = composed.kept;
        warnings.push(
          ...ignoredRegionEdits(current, parsed.regions, base),
          ...preserved.warnings,
        );
      });
      await claimAttachments(ctx, parsed.attachmentIds, page);
      // Last editor, contributors, watchers and (optionally) the title, as
      // core's own update does.
      await ctx.deps.pageService.update(
        page,
        { pageId: page.id, title: newTitle } as UpdatePageDto,
        ctx.user,
      );
      if (newTitle !== undefined && newTitle !== page.title) {
        await notifyTree(ctx, { ...page, title: newTitle }, 'meta');
      }
      return toolJson({
        success: true,
        docId: page.id,
        linkedPages: parsed.linkedPages,
        kept,
        ...(warnings.length ? { warnings } : {}),
        message: 'Document updated successfully',
      });
    } catch (error) {
      return toolError(`Failed to update document: ${errorMessage(error)}`);
    }
  },
});

export const updateDocumentMetaTool = defineTool({
  name: 'update_document_meta',
  title: 'Update Document Metadata',
  description:
    'Rename a document and/or set its emoji icon (shown in the sidebar and page header). Pass icon "" to remove the icon. The body is not touched.',
  access: 'write',
  audience: 'all',
  inputSchema: z
    .object({
      docId: DOC_ID,
      title: TITLE.optional().describe('The new document title'),
      icon: z
        .string()
        .max(32)
        .optional()
        .describe('An emoji, or "" for none'),
    })
    .strict(),
  execute: async ({ docId, title, icon }, ctx) => {
    if (title === undefined && icon === undefined) {
      return toolError('Pass title and/or icon.');
    }
    const page = await editablePage(ctx, docId);
    if (isRefusal(page)) return page.refused;
    const newTitle = title === undefined ? undefined : cleanTitle(title);
    if (newTitle === '') return toolError('Title is empty.');
    const newIcon = icon === undefined ? undefined : icon.trim() || null;
    if (newIcon && /\s/.test(newIcon)) {
      return toolError('icon must be a single emoji.');
    }
    try {
      const updated = await ctx.deps.pageService.update(
        page,
        { pageId: page.id, title: newTitle, icon: newIcon } as UpdatePageDto,
        ctx.user,
      );
      await notifyTree(ctx, updated, 'meta');
      return toolJson({
        success: true,
        docId: page.id,
        title: updated.title,
        icon: updated.icon ?? null,
        message: 'Document metadata updated successfully',
      });
    } catch (error) {
      return toolError(`Failed to update document: ${errorMessage(error)}`);
    }
  },
});

export const documentWriteTools: McpTool<any>[] = [
  createDocumentTool,
  updateDocumentTool,
  updateDocumentMetaTool,
];
