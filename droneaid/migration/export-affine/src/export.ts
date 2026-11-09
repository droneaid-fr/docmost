/**
 * Writes workspaces, docs, databases and blobs into the bundle. Returns the
 * statistics the report and the count check are built from.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { BundleWriter } from './bundle.ts';
import { type BlockEntry, docBody, docCanvas, docDatabases, translationBody } from './docs.ts';
import type { Fork } from './fork.ts';
import {
  affineLinkTargets,
  blobFileName,
  byKey,
  commentText,
  isoOrNull,
  OLD_HOSTS,
  oldHostLinks,
} from './pure.ts';
import type { SourceData } from './source.ts';
import { docFolderPaths, folderTree, pageDates, readWorkspaceYjs } from './workspace.ts';

export type FlavourStat = { flavour: string; handling: string; blocks: number; docs: Set<string>; edgelessOnly: number };

export type ExportStats = {
  docs: number;
  docsByWorkspace: Record<string, number>;
  databases: { workspaceId: string; docId: string; docTitle: string; databaseId: string; title: string; rows: number; columns: number }[];
  flavours: Map<string, FlavourStat>;
  inlineAttributes: Record<string, number>;
  inlineLatex: number;
  blobsCopied: number;
  blobBytes: number;
  blobProblems: string[];
  blobsUnreferenced: string[];
  blobRefsWithoutBlob: string[];
  canvasDocs: { docId: string; title: string; elements: Record<string, number> }[];
  readerUnsupported: Record<string, number>;
  readerUnknown: Record<string, number>;
  childrenDropped: { docId: string; blockId: string; flavour: string; children: number }[];
  notInBody: { docId: string; blockId: string; flavour: string }[];
  orphanBlocks: number;
  oldHostLinkDocs: { docId: string; links: string[] }[];
  trashed: number;
  comments: number;
  replies: number;
  translations: number;
  metaWithoutSnapshot: string[];
  docPaths: Map<string, string>;
  publishedDocs: { workspaceId: string; docId: string; title: string; mode: string; publishedAt: string | null; translations: string[] }[];
  collections: { workspaceId: string; id: string }[];
  tags: { workspaceId: string; id: string }[];
};

const PUBLISH_MODE = ['page', 'edgeless'];

export function exportWorkspaces(fork: Fork, src: SourceData, out: BundleWriter, storageDir: string): ExportStats {
  const stats: ExportStats = {
    docs: 0,
    docsByWorkspace: {},
    databases: [],
    flavours: new Map(),
    inlineAttributes: {},
    inlineLatex: 0,
    blobsCopied: 0,
    blobBytes: 0,
    blobProblems: [],
    blobsUnreferenced: [],
    blobRefsWithoutBlob: [],
    canvasDocs: [],
    readerUnsupported: {},
    readerUnknown: {},
    childrenDropped: [],
    notInBody: [],
    orphanBlocks: 0,
    oldHostLinkDocs: [],
    trashed: 0,
    comments: 0,
    replies: 0,
    translations: 0,
    metaWithoutSnapshot: [],
    docPaths: new Map(),
    publishedDocs: [],
    collections: [],
    tags: [],
  };
  const users = new Map(src.users.map(u => [u.id, u]));
  const userRef = (id: string | null | undefined) =>
    id ? { userId: id, email: users.get(id)?.email ?? null, agent: !!users.get(id)?.agent_of_workspace_id } : null;

  for (const ws of src.workspaces) {
    const wsDir = `workspaces/${ws.id}`;
    const y = readWorkspaceYjs(fork, ws.id, src.systemSnapshots);
    const pageById = new Map(y.pages.map(p => [p.id, p]));
    const tagById = new Map(y.tags.map(t => [String(t.id), t]));
    const titleOf = (docId: string) => pageById.get(docId)?.title;
    const linkTitle = (type: string, id: string) =>
      type === 'doc'
        ? titleOf(id)
        : type === 'tag'
          ? (tagById.get(id)?.value as string | undefined)
          : (y.collections.find(c => c.id === id)?.name as string | undefined);
    const propsById = new Map(y.docProperties.map(r => [String(r.id), r]));
    const members = src.members.filter(m => m.workspace_id === ws.id);
    const owner = members.find(m => m.role === 'owner');
    const agent = src.users.find(u => u.agent_of_workspace_id === ws.id);
    const policy = src.accessPolicies.find(p => p.workspace_id === ws.id);
    const wsBlobs = src.blobs.filter(b => b.workspace_id === ws.id);
    const blobRefs = new Map<string, { docId: string; blockId: string; flavour: string }[]>();
    const snapshotIds = new Set<string>();

    // ------------------------------------------------------------- docs
    for (const snap of src.docSnapshots.filter(s => s.workspace_id === ws.id)) {
      const docId = snap.guid;
      snapshotIds.add(docId);
      const docDir = `${wsDir}/docs/${docId}`;
      const doc = new fork.Y.Doc();
      fork.Y.applyUpdate(doc, snap.blob);
      try {
        const body = docBody(fork, ws.id, docId, doc, titleOf);
        const databases = docDatabases(fork, doc);
        const canvas = docCanvas(fork, doc);
        const meta = pageById.get(docId);
        const wp = src.pages.find(p => p.workspace_id === ws.id && p.page_id === docId);
        const props = propsById.get(docId) ?? {};
        const policyRow = src.docPolicies.find(p => p.workspace_id === ws.id && p.doc_id === docId);
        const title = meta?.title || wp?.title || body.title || '';

        out.text(`${docDir}/body.md`, body.markdown);
        if (body.edgelessNotesMarkdown) out.text(`${docDir}/edgeless-notes.md`, body.edgelessNotesMarkdown);
        for (const db of databases) {
          out.json(`${docDir}/databases/${db.databaseId}.json`, { workspaceId: ws.id, docId, ...db });
          stats.databases.push({
            workspaceId: ws.id,
            docId,
            docTitle: title,
            databaseId: db.databaseId,
            title: db.title,
            rows: db.rowCount,
            columns: db.columns.length,
          });
        }
        if (canvas) {
          out.json(`${docDir}/canvas.json`, canvas);
          const elements: Record<string, number> = {};
          for (const el of Object.values(canvas.elements) as { type?: string }[]) {
            elements[String(el.type)] = (elements[String(el.type)] ?? 0) + 1;
          }
          stats.canvasDocs.push({ docId, title, elements });
        }

        // Comments
        const comments = src.comments
          .filter(c => c.workspace_id === ws.id && c.doc_id === docId)
          .map(c => ({
            id: c.id,
            author: userRef(c.user_id),
            createdAt: isoOrNull(c.created_at),
            updatedAt: isoOrNull(c.updated_at),
            deletedAt: isoOrNull(c.deleted_at),
            resolved: c.resolved,
            text: commentText(c.content),
            content: c.content,
            replies: src.replies
              .filter(r => r.comment_id === c.id)
              .map(r => ({
                id: r.id,
                author: userRef(r.user_id),
                createdAt: isoOrNull(r.created_at),
                updatedAt: isoOrNull(r.updated_at),
                deletedAt: isoOrNull(r.deleted_at),
                text: commentText(r.content),
                content: r.content,
              })),
          }));
        if (comments.length) {
          out.json(`${docDir}/comments.json`, comments);
          stats.comments += comments.length;
          stats.replies += comments.reduce((n, c) => n + c.replies.length, 0);
        }

        // Translations
        const translations = src.translations
          .filter(t => t.workspace_id === ws.id && t.doc_id === docId)
          .map(t => {
            const file = t.bin ? `${docDir}/translations/${t.lang}.md` : null;
            if (t.bin && file) {
              const tr = translationBody(fork, ws.id, docId, t.bin, titleOf);
              out.text(file, tr.markdown);
            }
            stats.translations++;
            return {
              lang: t.lang,
              sourceLang: t.source_lang,
              status: t.status,
              title: t.title,
              error: t.error,
              sourceTimestamp: isoOrNull(t.source_timestamp),
              updatedAt: isoOrNull(t.updated_at),
              file: file ? file.slice(docDir.length + 1) : null,
            };
          });

        // Blocks: keep the special ones, count all of them.
        const flavourCounts: Record<string, number> = {};
        for (const b of body.blocks) {
          const name = b.type ? `${b.flavour}:${b.type}` : b.flavour;
          flavourCounts[name] = (flavourCounts[name] ?? 0) + 1;
          // One row per flavour and handling (an image in the page vs on the canvas).
          const key = `${name} ${b.handling}`;
          const stat = stats.flavours.get(key) ?? { flavour: name, handling: b.handling, blocks: 0, docs: new Set(), edgelessOnly: 0 };
          stat.blocks++;
          stat.docs.add(`${ws.id}/${docId}`);
          if (b.edgelessOnly) stat.edgelessOnly++;
          stats.flavours.set(key, stat);
          if (b.childrenDropped) stats.childrenDropped.push({ docId, blockId: b.id, flavour: b.flavour, children: b.childrenDropped });
          if (b.representation?.startsWith('(not printed)')) stats.notInBody.push({ docId, blockId: b.id, flavour: b.flavour });
          const key2 = b.props?.sourceId;
          if (typeof key2 === 'string' && key2) {
            const refs = blobRefs.get(key2) ?? [];
            refs.push({ docId, blockId: b.id, flavour: b.flavour });
            blobRefs.set(key2, refs);
          }
        }
        const special: BlockEntry[] = body.blocks.filter(b => b.handling !== 'markdown' && b.handling !== 'structural' && b.flavour !== 'affine:surface');
        for (const [k, v] of Object.entries(body.inline.attributes)) stats.inlineAttributes[k] = (stats.inlineAttributes[k] ?? 0) + v;
        stats.inlineLatex += body.inline.inlineLatex;
        body.readerUnsupported.forEach(f => (stats.readerUnsupported[f] = (stats.readerUnsupported[f] ?? 0) + 1));
        body.readerUnknown.forEach(f => (stats.readerUnknown[f] = (stats.readerUnknown[f] ?? 0) + 1));
        stats.orphanBlocks += body.orphanBlocks;
        const oldLinks = oldHostLinks(body.markdown, OLD_HOSTS);
        if (oldLinks.length) stats.oldHostLinkDocs.push({ docId, links: oldLinks });

        const published = policyRow?.visibility === 'public';
        const docTags = (meta?.tags ?? []).map(id => ({ id, name: (tagById.get(id)?.value as string | undefined) ?? null }));
        const { id: _id, ...properties } = props as Record<string, unknown>;
        const dates = pageDates(meta);
        if (meta?.trash) stats.trashed++;
        const docJson = {
          workspaceId: ws.id,
          docId,
          title,
          titles: { rootMeta: meta?.title ?? null, workspacePages: wp?.title ?? null, reader: body.title },
          createdAt: dates.createDate ?? isoOrNull(snap.created_at),
          updatedAt: dates.updatedDate ?? isoOrNull(snap.updated_at),
          snapshot: {
            createdAt: isoOrNull(snap.created_at),
            updatedAt: isoOrNull(snap.updated_at),
            createdBy: userRef(snap.created_by),
            updatedBy: userRef(snap.updated_by),
            historyVersions: Number(src.historyCounts.find(h => h.workspace_id === ws.id && h.guid === docId)?.n ?? 0),
          },
          createdBy: userRef((properties.createdBy as string | undefined) ?? snap.created_by),
          updatedBy: userRef((properties.updatedBy as string | undefined) ?? snap.updated_by),
          trash: meta?.trash ?? false,
          trashDate: dates.trashDate,
          inRootMeta: !!meta,
          mode: properties.primaryMode === 'edgeless' ? 'edgeless' : 'page',
          tags: docTags,
          properties,
          folders: docFolderPaths(y.folders, docId),
          publish: {
            published,
            visibility: policyRow?.visibility ?? 'private',
            publicRole: policyRow?.public_role ?? null,
            memberDefaultRole: policyRow?.member_default_role ?? null,
            urlPreviewEnabled: policyRow?.url_preview_enabled ?? false,
            publishedAt: isoOrNull(policyRow?.published_at ?? wp?.published_at ?? null),
            mode: PUBLISH_MODE[wp?.mode ?? 0] ?? String(wp?.mode),
            blocked: wp?.blocked ?? false,
          },
          body: 'body.md',
          edgelessNotes: body.edgelessNotesMarkdown ? { file: 'edgeless-notes.md', noteIds: body.edgelessNotes } : null,
          databases: databases.map(db => ({ id: db.databaseId, title: db.title, rows: db.rowCount, columns: db.columns.length, file: `databases/${db.databaseId}.json` })),
          canvas: canvas ? 'canvas.json' : null,
          comments: comments.length ? 'comments.json' : null,
          translations,
          flavourCounts,
          blocks: special,
          blobs: [...new Set(special.map(b => b.props?.sourceId).filter((k): k is string => typeof k === 'string' && !!k))].sort(),
          links: { affine: affineLinkTargets(body.markdown), oldHost: oldLinks },
          inline: body.inline,
          reader: { knownUnsupported: body.readerUnsupported, unknown: body.readerUnknown },
          orphanBlocks: body.orphanBlocks,
        };
        out.json(`${docDir}/doc.json`, docJson);
        stats.docPaths.set(`${ws.id}/${docId}`, docDir);
        stats.docs++;
        stats.docsByWorkspace[ws.id] = (stats.docsByWorkspace[ws.id] ?? 0) + 1;
        if (published) {
          stats.publishedDocs.push({
            workspaceId: ws.id,
            docId,
            title,
            mode: docJson.publish.mode,
            publishedAt: docJson.publish.publishedAt,
            translations: translations.map(t => t.lang),
          });
        }
      } finally {
        doc.destroy();
      }
    }
    for (const page of y.pages) {
      if (!snapshotIds.has(page.id)) stats.metaWithoutSnapshot.push(`${ws.id}/${page.id} ${JSON.stringify(page.title)}`);
    }

    // ------------------------------------------------------------ blobs
    const blobIndex = wsBlobs.map(b => {
      const file = `blobs/${ws.id}/${blobFileName(b.key, b.mime)}`;
      const source = join(storageDir, ws.id, b.key);
      let sha: string | null = null;
      if (!existsSync(source)) {
        stats.blobProblems.push(`missing file for ${ws.id}/${b.key}`);
      } else {
        const size = statSync(source).size;
        if (size !== b.size) stats.blobProblems.push(`size mismatch ${ws.id}/${b.key}: db ${b.size}, file ${size}`);
        sha = out.copy(file, source).sha256;
        stats.blobsCopied++;
        stats.blobBytes += size;
      }
      const refs = (blobRefs.get(b.key) ?? []).sort(byKey(r => `${r.docId}/${r.blockId}`));
      const isAvatar = ws.avatar_key === b.key;
      if (!refs.length && !isAvatar) stats.blobsUnreferenced.push(`${ws.id}/${b.key}`);
      return {
        key: b.key,
        mime: b.mime,
        size: b.size,
        sha256: sha,
        file: sha ? file : null,
        createdAt: isoOrNull(b.created_at),
        status: b.status,
        deletedAt: isoOrNull(b.deleted_at),
        workspaceAvatar: isAvatar,
        referencedBy: refs,
      };
    });
    const known = new Set(wsBlobs.map(b => b.key));
    for (const [key, refs] of blobRefs) {
      if (!known.has(key)) stats.blobRefsWithoutBlob.push(`${ws.id}/${key} (${refs.map(r => r.docId).join(', ')})`);
    }
    out.json(`${wsDir}/blobs.json`, blobIndex);

    // -------------------------------------------------------- workspace
    const tree = folderTree(y.folders, linkTitle);
    out.json(`${wsDir}/folders.json`, { tree: tree.folders, looseLinks: tree.looseLinks, danglingFolders: tree.danglingFolders, rows: y.folders });
    out.json(`${wsDir}/tags.json`, y.tags);
    out.json(`${wsDir}/collections.json`, y.collections);
    out.json(`${wsDir}/sidebar.json`, {
      favorites: y.userdata.filter(u => u.table === 'favorite').map(u => ({ user: userRef(u.userId), rows: u.rows })),
      otherUserdata: y.userdata.filter(u => u.table !== 'favorite').map(u => ({ user: userRef(u.userId), table: u.table, rows: u.rows })),
      pinnedCollections: y.pinnedCollections,
      explorerIcon: y.explorerIcon,
    });
    out.json(`${wsDir}/custom-properties.json`, y.customPropertyInfo);
    out.json(
      `${wsDir}/doc-grants.json`,
      src.docGrants
        .filter(g => g.workspace_id === ws.id)
        .map(g => ({
          docId: g.doc_id,
          docTitle: titleOf(g.doc_id) ?? null,
          principalType: g.principal_type,
          principal: g.principal_type === 'user' ? userRef(g.principal_id) : { groupId: g.principal_id },
          role: g.role,
          grantedBy: userRef(g.granted_by),
          createdAt: isoOrNull(g.created_at),
        }))
    );
    out.json(`${wsDir}/workspace.json`, {
      id: ws.id,
      name: ws.name,
      createdAt: isoOrNull(ws.created_at),
      avatarKey: ws.avatar_key,
      enableAi: ws.enable_ai,
      enableDocEmbedding: ws.enable_doc_embedding,
      owner: userRef(owner?.user_id),
      members: members.map(m => ({ ...userRef(m.user_id), role: m.role, state: m.state, source: m.source, createdAt: isoOrNull(m.created_at) })),
      agent: agent ? userRef(agent.id) : null,
      sharing: policy
        ? {
            visibility: policy.visibility,
            sharingEnabled: policy.sharing_enabled,
            urlPreviewEnabled: policy.url_preview_enabled,
            memberDefaultDocRole: policy.member_default_doc_role,
          }
        : null,
      invitations: src.invitations
        .filter(i => i.workspace_id === ws.id)
        .map(i => ({ email: i.normalized_email, role: i.requested_role, status: i.status, kind: i.kind, createdAt: isoOrNull(i.created_at), expiresAt: isoOrNull(i.expires_at) })),
      counts: {
        docs: stats.docsByWorkspace[ws.id] ?? 0,
        rootMetaPages: y.pages.length,
        trashed: y.pages.filter(p => p.trash).length,
        blobs: wsBlobs.length,
        folders: y.folders.filter(f => f.type === 'folder').length,
        folderLinks: y.folders.filter(f => f.type !== 'folder').length,
        tags: y.tags.length,
        collections: y.collections.length,
      },
      systemDocs: y.systemDocs,
    });
    y.collections.forEach(c => stats.collections.push({ workspaceId: ws.id, id: String(c.id) }));
    y.tags.forEach(t => stats.tags.push({ workspaceId: ws.id, id: String(t.id) }));
  }
  return stats;
}
