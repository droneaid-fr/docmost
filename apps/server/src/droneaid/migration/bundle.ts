import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Typed reader for the S6a migration bundle (`bundleFormat: 1`, see
 * droneaid/migration/export-affine/README.md). Only the fields the importer
 * uses are typed; everything is read, never written.
 */

export type BundlePrincipal = {
  userId: string | null;
  email: string | null;
  agent: boolean | null;
};

export type BundleUser = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  registered: boolean;
  disabled: boolean;
  admin: boolean;
  agentOfWorkspaceId: string | null;
  createdAt: string;
  emailVerified: string | null;
  memberships: { workspaceId: string; role: string; state: string }[];
};

export type BundleMember = {
  userId: string;
  email: string;
  role: string; // owner | admin | member | external
  state: string; // active | pending | ...
  agent: boolean;
  source?: string;
};

export type BundleWorkspace = {
  id: string;
  name: string;
  owner: BundlePrincipal;
  members: BundleMember[];
  agent: BundlePrincipal | null;
  avatarKey: string | null;
  invitations: unknown[];
  sharing?: { memberDefaultDocRole?: string };
};

export type FolderItem = {
  index: string;
  linkId: string;
  targetId: string;
  title: string;
  type: string; // doc | tag | collection | folder
};

export type FolderNode = {
  id: string;
  name: string;
  index: string;
  folders: FolderNode[];
  items: FolderItem[];
};

export type BundleFolders = {
  tree: FolderNode[];
  looseLinks: FolderItem[];
  danglingFolders: FolderNode[];
};

export type BundleGrant = {
  docId: string;
  docTitle: string | null;
  principal: BundlePrincipal;
  principalType: string;
  role: string;
  createdAt: string;
};

export type BundleBlob = {
  key: string;
  mime: string;
  size: number;
  sha256: string;
  file: string;
  referencedBy: { docId: string; blockId: string; flavour: string }[];
  workspaceAvatar: boolean;
};

export type BundleBlock = {
  id: string;
  flavour: string;
  handling: string;
  parentId: string | null;
  props: Record<string, any>;
  representation?: string;
  edgelessOnly?: boolean;
};

export type BundleTranslation = {
  lang: string;
  sourceLang: string;
  status: string;
  title: string | null;
  file: string;
};

export type BundleDoc = {
  workspaceId: string;
  docId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  createdBy: BundlePrincipal | null;
  updatedBy: BundlePrincipal | null;
  trash: boolean;
  trashDate: string | null;
  mode: string;
  publish: {
    published: boolean;
    mode: string | null;
    publishedAt: string | null;
    memberDefaultRole: string | null;
  };
  body: string;
  edgelessNotes: { file: string; noteIds: string[] } | null;
  databases: {
    id: string;
    title: string;
    rows: number;
    columns: number;
    file: string;
  }[];
  comments: string | null;
  translations: BundleTranslation[];
  blocks: BundleBlock[];
  blobs: string[];
  links: { affine: string[]; oldHost: string[] };
  inline: { attributes: Record<string, number>; inlineLatex: number };
};

export type BundleDatabaseColumn = {
  id: string;
  name: string;
  type: string;
  data: any;
  options?: string[];
  virtual?: boolean;
};

export type BundleDatabase = {
  databaseId: string;
  title: string;
  columns: BundleDatabaseColumn[];
  rowCount: number;
  rows: { id: string; values: Record<string, any>; richText?: any }[];
  views: any[];
};

export type BundleComment = {
  id: string;
  author: BundlePrincipal;
  content: any;
  text: string | null;
  createdAt: string;
  deletedAt: string | null;
  resolved?: boolean;
  replies?: BundleComment[];
};

export type BundlePublishedDoc = {
  workspaceId: string;
  docId: string;
  title: string;
  mode: string;
  publishedAt: string;
  translations: string[];
};

export type BundleOldUrl = {
  kind: string;
  path: string;
  workspaceId?: string;
  docId?: string;
  targetId?: string;
  published?: boolean;
};

export type SignupAllowEntry = {
  pattern: string;
  role: string;
  workspaces: string[];
};

export type LoadedWorkspace = {
  workspace: BundleWorkspace;
  folders: BundleFolders;
  grants: BundleGrant[];
  blobs: BundleBlob[];
  docs: BundleDoc[];
};

export type Bundle = {
  dir: string;
  sha256: string;
  counts: Record<string, any>;
  users: BundleUser[];
  agents: {
    userId: string;
    email: string;
    workspaceId: string;
    grants: { docId: string; role: string; workspaceId: string }[];
  }[];
  signupAllowlist: SignupAllowEntry[];
  published: BundlePublishedDoc[];
  oldUrls: { canonicalHost: string; hosts: string[]; paths: BundleOldUrl[] };
  workspaces: LoadedWorkspace[];
};

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function loadBundle(dir: string): Promise<Bundle> {
  const root = path.resolve(dir);
  const manifest = await readJson<any>(path.join(root, 'manifest.json'));
  if (manifest.bundleFormat !== 1) {
    throw new Error(
      `Unsupported bundle format ${manifest.bundleFormat} (expected 1)`,
    );
  }
  if (manifest.checksPassed === false) {
    throw new Error('The bundle failed its own count checks; refusing.');
  }
  const instance = (name: string) => path.join(root, 'instance', name);
  const appConfig = await readJson<any>(instance('app-config.json'));

  const workspaceDirs = (
    await fs.readdir(path.join(root, 'workspaces'), { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const workspaces: LoadedWorkspace[] = [];
  for (const wsId of workspaceDirs) {
    const wsDir = path.join(root, 'workspaces', wsId);
    const docIds = (
      await fs.readdir(path.join(wsDir, 'docs'), { withFileTypes: true })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const docs: BundleDoc[] = [];
    for (const docId of docIds) {
      docs.push(await readJson(path.join(wsDir, 'docs', docId, 'doc.json')));
    }
    const blobs = await readJson<any>(path.join(wsDir, 'blobs.json'));
    workspaces.push({
      workspace: await readJson(path.join(wsDir, 'workspace.json')),
      folders: await readJson(path.join(wsDir, 'folders.json')),
      grants: await readJson(path.join(wsDir, 'doc-grants.json')),
      blobs: Array.isArray(blobs) ? blobs : blobs.blobs,
      docs,
    });
  }

  return {
    dir: root,
    sha256: manifest.bundleSha256,
    counts: manifest.counts ?? {},
    users: await readJson(instance('users.json')),
    agents: await readJson(instance('agents.json')),
    signupAllowlist: appConfig.signupAllowlist ?? [],
    published: await readJson(instance('published-docs.json')),
    oldUrls: await readJson(instance('old-urls.json')),
    workspaces,
  };
}

export function docDir(bundle: Bundle, doc: BundleDoc): string {
  return path.join(bundle.dir, 'workspaces', doc.workspaceId, 'docs', doc.docId);
}

export async function readDocFile(
  bundle: Bundle,
  doc: BundleDoc,
  file: string | null | undefined,
): Promise<string | null> {
  if (!file) return null;
  const full = path.join(docDir(bundle, doc), file);
  return (await exists(full)) ? fs.readFile(full, 'utf8') : null;
}

export async function readDocJson<T>(
  bundle: Bundle,
  doc: BundleDoc,
  file: string,
): Promise<T> {
  return readJson<T>(path.join(docDir(bundle, doc), file));
}

export function blobPath(bundle: Bundle, blob: BundleBlob): string {
  return path.join(bundle.dir, blob.file);
}
