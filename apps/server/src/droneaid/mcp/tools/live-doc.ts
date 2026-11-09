import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { updateYFragment } from 'y-prosemirror';
import { jsonToNode } from '../../../collaboration/collaboration.util';
import type { McpToolContext } from './context';

export const DEFAULT_FRAGMENT = 'default';

/**
 * Runs `fn` on the page's live Y.Doc inside the collaboration server, the
 * same path core uses for REST content writes (CollaborationHandler
 * .withYdocConnection). Open editors receive the change at once, and
 * Hocuspocus persists it (content, ydoc, text_content, history) as for any
 * edit. `pages.content` is never written directly.
 *
 * With Redis sync, a doc may be owned by another collaboration instance.
 * We claim it first (lockDocument); if another instance holds it, the write
 * is refused rather than editing a second copy.
 */
export async function withLiveDoc<T>(
  ctx: McpToolContext,
  pageId: string,
  fn: (doc: Y.Doc) => T,
): Promise<T> {
  const documentName = `page.${pageId}`;
  const gateway = ctx.deps.collaborationGateway;
  const locked = !ctx.deps.environmentService.isCollabDisableRedis();
  if (locked) {
    try {
      await gateway.lockDocument(documentName);
    } catch {
      throw new Error(
        'This document is held by another collaboration server; try again in a moment.',
      );
    }
  }
  let connection: Awaited<ReturnType<typeof gateway.openDirectConnection>>;
  try {
    connection = await gateway.openDirectConnection(documentName, {
      user: ctx.user,
    });
  } catch (err) {
    // The doc never loaded, so afterUnloadDocument will not release the lock
    // and its renewal interval would run forever. Once connected, the normal
    // disconnect → unload path releases it.
    if (locked) await gateway.releaseLock(documentName).catch(() => {});
    throw err;
  }
  let result: T;
  try {
    await connection.transact((doc: Y.Doc) => {
      result = fn(doc);
    });
  } finally {
    await connection.disconnect();
  }
  return result;
}

/** The doc's ProseMirror JSON as the editors see it right now. */
export function liveJson(doc: Y.Doc): any {
  return TiptapTransformer.fromYdoc(doc, DEFAULT_FRAGMENT);
}

/**
 * Brings the Y fragment to `json` with y-prosemirror's own diff (the one the
 * editor binding uses): unchanged blocks keep their Yjs identity, so cursors,
 * comments and concurrent edits in them survive, and a block that is equal
 * before and after (a kept database) is not touched at all.
 */
export function replaceFragment(doc: Y.Doc, json: any) {
  const node = jsonToNode(json);
  const fragment = doc.getXmlFragment(DEFAULT_FRAGMENT);
  doc.transact(() => {
    updateYFragment(doc, fragment, node, {
      mapping: new Map(),
      isOMark: new Map(),
    } as any);
  });
}
