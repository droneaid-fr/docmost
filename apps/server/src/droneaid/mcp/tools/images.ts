import * as bytes from 'bytes';
import { z } from 'zod';
import { v7 as uuid7 } from 'uuid';
import { AttachmentType } from '../../../core/attachment/attachment.constants';
import { getAttachmentFolderPath } from '../../../core/attachment/attachment.utils';
import {
  defineTool,
  errorMessage,
  McpTool,
  toolError,
  toolJson,
} from './define';
import { fileUrl } from './markdown-in';
import { editablePage, isRefusal } from './write-access';

/** The cap pdf-import already works to (its MAX_IMAGE_BYTES), as in AFFiNE. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const IMAGE_TYPES: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
};

export function decodeImage(data: string): Buffer {
  return Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64');
}

/**
 * Stores an image with core's attachment service (storage driver + an
 * `attachments` row), as the editor's own upload does. With doc_id it is
 * attached to that page right away. Without, it waits in your own space and
 * is attached to the first page whose markdown shows it (create_document /
 * update_document), so core serves it to everyone who can view that page.
 */
export const uploadImageTool = defineTool({
  name: 'upload_image',
  title: 'Upload Image',
  description:
    'Upload an image (base64, max 10 MB). Returns its key and a `markdown` snippet; put that snippet (or `![alt](blob://<key>)`) in create_document / update_document markdown to show the image. URLs are not fetched: pass the bytes. Optional doc_id: the document it belongs to (otherwise it is attached to the first document that uses it).',
  access: 'write',
  audience: 'all',
  inputSchema: z
    .object({
      data_base64: z.string().min(1).describe('Image bytes, base64'),
      mime_type: z
        .string()
        .refine((value) => value in IMAGE_TYPES, 'Unsupported image type')
        .describe(
          'image/png, image/jpeg, image/gif, image/webp, image/svg+xml, image/bmp or image/avif',
        ),
      doc_id: z.string().min(1).max(100).optional(),
    })
    .strict(),
  execute: async ({ data_base64, mime_type, doc_id }, ctx) => {
    const data = decodeImage(data_base64);
    if (data.byteLength === 0) return toolError('Image data is empty.');
    const limit = Math.min(
      MAX_IMAGE_BYTES,
      bytes(ctx.deps.environmentService.getFileUploadSizeLimit()) ??
        MAX_IMAGE_BYTES,
    );
    if (data.byteLength > limit) {
      return toolError(`Image is larger than ${bytes(limit)}.`);
    }

    let pageId: string | null = null;
    let spaceId: string;
    if (doc_id) {
      const page = await editablePage(ctx, doc_id);
      if (isRefusal(page)) return page.refused;
      pageId = page.id;
      spaceId = page.spaceId;
    } else {
      spaceId = ctx.principal.agentSpaceId;
      if (!spaceId) {
        return toolError('Pass doc_id: the document the image belongs to.');
      }
      if (!(await ctx.canCreateInSpace(spaceId))) {
        return toolError('You cannot upload files to your space.');
      }
    }

    try {
      const id = uuid7();
      const fileExtension = IMAGE_TYPES[mime_type];
      const fileName = `image-${id.slice(-12)}${fileExtension}`;
      const filePath = `${getAttachmentFolderPath(AttachmentType.File, ctx.workspace.id)}/${id}/${fileName}`;
      const service = ctx.deps.attachmentService;
      await service.uploadToDrive(filePath, data);
      const attachment = await service.saveAttachment({
        attachmentId: id,
        preparedFile: {
          fileName,
          fileSize: data.byteLength,
          fileExtension,
          mimeType: mime_type,
        },
        filePath,
        type: AttachmentType.File,
        userId: ctx.user.id,
        workspaceId: ctx.workspace.id,
        pageId: pageId ?? undefined,
        spaceId,
      });
      const url = fileUrl(attachment);
      return toolJson({
        success: true,
        key: attachment.id,
        attachmentId: attachment.id,
        url,
        markdown: `![](${url})`,
        docId: pageId,
      });
    } catch (error) {
      return toolError(`Failed to upload image: ${errorMessage(error)}`);
    }
  },
});

export const imageTools: McpTool<any>[] = [uploadImageTool];
