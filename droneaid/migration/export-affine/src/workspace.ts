/**
 * Workspace-level data that lives in Yjs, read with the fork's helpers
 * (workspace-data.ts, orm-table.ts): the root doc (page meta, tags,
 * collections) and the ORM table docs `db$<ws>$<table>` / `userdata$...`.
 */
import type * as YT from 'yjs';

import type { Fork } from './fork.ts';
import { byKey, isoOrNull } from './pure.ts';

type Snapshot = { workspace_id: string; guid: string; blob: Uint8Array };

export type PageMeta = {
  id: string;
  title: string;
  tags: string[];
  createDate?: number;
  updatedDate?: number;
  trash: boolean;
  trashDate?: number;
};

export type FolderRow = {
  id: string;
  parentId: string | null;
  type: 'folder' | 'doc' | 'tag' | 'collection';
  data: string;
  index: string;
};

export type FolderNode = {
  id: string;
  name: string;
  index: string;
  folders: FolderNode[];
  items: { linkId: string; type: string; targetId: string; title?: string; index: string }[];
};

function load(fork: Fork, blob: Uint8Array | undefined): YT.Doc | null {
  if (!blob) return null;
  const doc = new fork.Y.Doc();
  fork.Y.applyUpdate(doc, blob);
  return doc;
}

const bySibling = (a: FolderRow, b: FolderRow) =>
  a.index < b.index ? -1 : a.index > b.index ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Same tree as list_folders, but every link type and the order keys kept. */
export function folderTree(rows: FolderRow[], titleOf: (type: string, id: string) => string | undefined) {
  const sorted = [...rows].sort(bySibling);
  const build = (parentId: string | null): FolderNode[] =>
    sorted
      .filter(row => row.type === 'folder' && row.parentId === parentId)
      .map(folder => ({
        id: folder.id,
        name: folder.data,
        index: folder.index,
        folders: build(folder.id),
        items: sorted
          .filter(row => row.parentId === folder.id && row.type !== 'folder')
          .map(row => ({
            linkId: row.id,
            type: row.type,
            targetId: row.data,
            title: titleOf(row.type, row.data),
            index: row.index,
          })),
      }));
  // Links whose parent is not a folder (root-level links, dangling parents).
  const folderIds = new Set(sorted.filter(r => r.type === 'folder').map(r => r.id));
  const loose = sorted.filter(
    row => row.type !== 'folder' && (row.parentId === null || !folderIds.has(row.parentId))
  );
  const danglingFolders = sorted.filter(
    row => row.type === 'folder' && row.parentId !== null && !folderIds.has(row.parentId)
  );
  return { folders: build(null), looseLinks: loose, danglingFolders };
}

/** Folder names from the top down to the folder holding each link of a doc. */
export function docFolderPaths(rows: FolderRow[], docId: string) {
  const byId = new Map(rows.map(row => [row.id, row]));
  return rows
    .filter(row => row.type === 'doc' && row.data === docId)
    .sort(bySibling)
    .map(link => {
      const path: { id: string; name: string }[] = [];
      const seen = new Set<string>();
      let current = link.parentId ? byId.get(link.parentId) : undefined;
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        if (current.type === 'folder') path.unshift({ id: current.id, name: current.data });
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return { linkId: link.id, folderId: link.parentId, index: link.index, path };
    });
}

export function readWorkspaceYjs(fork: Fork, workspaceId: string, snapshots: Snapshot[]) {
  const mine = snapshots.filter(s => s.workspace_id === workspaceId);
  const get = (guid: string) => mine.find(s => s.guid === guid)?.blob;
  const table = (name: string) => {
    const doc = load(fork, get(`db$${workspaceId}$${name}`));
    if (!doc) return [];
    try {
      return fork.listOrmRows(doc).sort(byKey(r => String(r.id ?? '')));
    } finally {
      doc.destroy();
    }
  };

  const root = load(fork, get(workspaceId));
  let pages: PageMeta[] = [];
  let tags: Record<string, unknown>[] = [];
  let collections: Record<string, unknown>[] = [];
  if (root) {
    try {
      pages = fork.listPages(root) as PageMeta[];
      tags = fork.listTags(root) as Record<string, unknown>[];
      collections = fork.listCollections(root) as Record<string, unknown>[];
    } finally {
      root.destroy();
    }
  }
  const folderDoc = load(fork, get(`db$${workspaceId}$folders`));
  let folders: FolderRow[] = [];
  if (folderDoc) {
    try {
      folders = (fork.folderRows(folderDoc) as FolderRow[]).sort(bySibling);
    } finally {
      folderDoc.destroy();
    }
  }

  // userdata$<userId>$<ws>$<table>: per-user data (favourites).
  const userdata = mine
    .filter(s => s.guid.startsWith('userdata$'))
    .map(s => {
      const [, userId, , name] = s.guid.split('$');
      const doc = load(fork, s.blob)!;
      try {
        return { userId, table: name, rows: fork.listOrmRows(doc).sort(byKey(r => String(r.id ?? r.key ?? ''))) };
      } finally {
        doc.destroy();
      }
    })
    .sort(byKey(u => `${u.userId}$${u.table}`));

  const systemDocs = mine.map(s => s.guid).sort();
  return {
    pages: [...pages].sort(byKey(p => p.id)),
    tags: tags.sort(byKey(t => String(t.id))),
    collections: collections.sort(byKey(c => String(c.id))),
    folders,
    docProperties: table('docProperties'),
    customPropertyInfo: table('docCustomPropertyInfo'),
    explorerIcon: table('explorerIcon'),
    pinnedCollections: table('pinnedCollections'),
    userdata,
    systemDocs,
  };
}

export function pageDates(page: PageMeta | undefined) {
  return {
    createDate: isoOrNull(page?.createDate),
    updatedDate: isoOrNull(page?.updatedDate),
    trashDate: isoOrNull(page?.trashDate),
  };
}
