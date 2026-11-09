import type { BundleDoc, BundleFolders, FolderNode } from './bundle';

/**
 * AFFiNE folder tree -> Docmost page tree (pure).
 *
 *  - a folder becomes a folder page; a doc in a folder becomes its child;
 *  - docs in no folder go to the top level of the space, after the folders,
 *    oldest first (AFFiNE gives them no order of their own);
 *  - siblings keep the sidebar order: subfolders and doc links of a folder
 *    share one fractional `index`, compared as plain strings;
 *  - a doc linked from several folders goes under the first one in sidebar
 *    order (depth-first); the other links are reported.
 *
 * Only `doc` links become pages. Tag and collection links have no Docmost
 * equivalent and are reported.
 */

export type TreeNode =
  | { kind: 'folder'; key: string; folderId: string; title: string; children: TreeNode[] }
  | { kind: 'doc'; key: string; docId: string; children: [] };

export type ExtraLink = {
  docId: string;
  keptUnder: string[]; // folder path of the placement
  alsoIn: string[][]; // folder paths of the links not reproduced
};

export type SkippedLink = {
  folderPath: string[];
  type: string;
  targetId: string;
  title: string;
};

export type TreePlan = {
  roots: TreeNode[];
  extraLinks: ExtraLink[];
  skippedLinks: SkippedLink[];
  /** Folder links to docs that are not in the bundle. */
  missingDocs: SkippedLink[];
};

export const folderKey = (folderId: string) => `folder:${folderId}`;
export const docKey = (docId: string) => `doc:${docId}`;

const byIndex = (a: { index: string }, b: { index: string }) =>
  a.index < b.index ? -1 : a.index > b.index ? 1 : 0;

export function planTree(folders: BundleFolders, docs: BundleDoc[]): TreePlan {
  const known = new Set(docs.map((d) => d.docId));
  const placedAt = new Map<string, string[]>();
  const extra = new Map<string, string[][]>();
  const skippedLinks: SkippedLink[] = [];
  const missingDocs: SkippedLink[] = [];

  const visit = (folder: FolderNode, parents: string[]): TreeNode => {
    const folderPath = [...parents, folder.name];
    const entries: ({ index: string } & (
      | { folder: FolderNode }
      | { item: FolderNode['items'][number] }
    ))[] = [
      ...folder.folders.map((f) => ({ index: f.index, folder: f })),
      ...folder.items.map((i) => ({ index: i.index, item: i })),
    ].sort(byIndex);

    const children: TreeNode[] = [];
    for (const entry of entries) {
      if ('folder' in entry) {
        children.push(visit(entry.folder, folderPath));
        continue;
      }
      const item = entry.item;
      const link = {
        folderPath,
        type: item.type,
        targetId: item.targetId,
        title: item.title,
      };
      if (item.type !== 'doc') {
        skippedLinks.push(link);
        continue;
      }
      if (!known.has(item.targetId)) {
        missingDocs.push(link);
        continue;
      }
      if (placedAt.has(item.targetId)) {
        extra.set(item.targetId, [...(extra.get(item.targetId) ?? []), folderPath]);
        continue;
      }
      placedAt.set(item.targetId, folderPath);
      children.push({ kind: 'doc', key: docKey(item.targetId), docId: item.targetId, children: [] });
    }
    return {
      kind: 'folder',
      key: folderKey(folder.id),
      folderId: folder.id,
      title: folder.name,
      children,
    };
  };

  const roots: TreeNode[] = [...folders.tree].sort(byIndex).map((f) => visit(f, []));

  const loose = docs
    .filter((d) => !placedAt.has(d.docId))
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.docId.localeCompare(b.docId),
    );
  for (const doc of loose) {
    roots.push({ kind: 'doc', key: docKey(doc.docId), docId: doc.docId, children: [] });
  }

  return {
    roots,
    extraLinks: [...extra.entries()].map(([docId, alsoIn]) => ({
      docId,
      keptUnder: placedAt.get(docId) ?? [],
      alsoIn,
    })),
    skippedLinks,
    missingDocs,
  };
}

/** Depth-first, parents before children, with each node's parent key. */
export function flattenTree(
  roots: TreeNode[],
): { node: TreeNode; parentKey: string | null; siblingIndex: number }[] {
  const out: { node: TreeNode; parentKey: string | null; siblingIndex: number }[] = [];
  const walk = (nodes: TreeNode[], parentKey: string | null) => {
    nodes.forEach((node, siblingIndex) => {
      out.push({ node, parentKey, siblingIndex });
      walk(node.children, node.key);
    });
  };
  walk(roots, null);
  return out;
}

/**
 * AFFiNE folders carry no dates; a folder page gets the creation time of its
 * oldest descendant doc (null when it holds none).
 */
export function folderCreatedAt(
  node: TreeNode,
  createdAtOf: (docId: string) => string | undefined,
): string | null {
  if (node.kind === 'doc') return createdAtOf(node.docId) ?? null;
  return node.children
    .map((child) => folderCreatedAt(child, createdAtOf))
    .filter((d): d is string => !!d)
    .sort()[0] ?? null;
}
