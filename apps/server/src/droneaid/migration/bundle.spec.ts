import { Bundle, DEFAULT_EXCLUDED_WORKSPACES, excludeWorkspaces, LoadedWorkspace, parseExcludeList } from './bundle';

const ws = (id: string, name: string, docs: { trash?: boolean; databases?: number }[], blobs: number[]): LoadedWorkspace => ({
  workspace: {
    id,
    name,
    owner: { userId: 'u1', email: 'a@x', agent: false },
    members: [{ userId: 'u1', email: 'a@x', role: 'owner', state: 'active', agent: false }],
    agent: null,
    avatarKey: null,
    invitations: [],
  },
  folders: { tree: [{ id: 'f', name: 'F', index: 'a', folders: [], items: [] }], looseLinks: [], danglingFolders: [] },
  grants: [{ docId: 'd', docTitle: null, principal: { userId: 'u1', email: null, agent: false }, principalType: 'user', role: 'owner', createdAt: '' }],
  blobs: blobs.map((size, i) => ({ key: `k${i}`, mime: 'image/png', size, sha256: '', file: '', referencedBy: [], workspaceAvatar: false })),
  docs: docs.map((d, i) => ({
    workspaceId: id,
    docId: `${id}-d${i}`,
    trash: !!d.trash,
    databases: Array.from({ length: d.databases ?? 0 }, () => ({ id: 'db', title: '', rows: 0, columns: 0, file: '' })),
    publish: { published: false },
    translations: [],
    comments: null,
  })) as any,
});

const bundle = (): Bundle => ({
  dir: '/b',
  sha256: 'sha',
  counts: {},
  users: [],
  agents: [
    { userId: 'ag1', email: 'agent.w1', workspaceId: 'w1', grants: [] },
    { userId: 'ag2', email: 'agent.demo', workspaceId: 'demo', grants: [] },
  ],
  signupAllowlist: [{ pattern: 'droneaid.fr', role: 'Collaborator', workspaces: ['w1'] }],
  published: [{ workspaceId: 'w1', docId: 'w1-d0', title: '', mode: 'page', publishedAt: '', translations: [] }],
  oldUrls: {
    canonicalHost: 'h',
    hosts: ['h'],
    paths: [
      { kind: 'doc', path: '/workspace/w1/w1-d0', workspaceId: 'w1', docId: 'w1-d0' },
      { kind: 'doc', path: '/workspace/demo/demo-d0', workspaceId: 'demo', docId: 'demo-d0' },
      { kind: 'blob', path: '/api/workspaces/demo/blobs/k0', workspaceId: 'demo', targetId: 'k0' },
      { kind: 'invite', path: '/invite/x' },
    ],
  },
  workspaces: [ws('demo', 'Demo Workspace', [{ databases: 1 }, {}, { trash: true }], [10, 20]), ws('w1', 'DroneAid France', [{}], [5])],
  excluded: [],
});

describe('excludeWorkspaces', () => {
  it('excludes "Demo Workspace" by default', () => {
    expect(DEFAULT_EXCLUDED_WORKSPACES).toEqual(['Demo Workspace']);
  });

  it('drops the workspace, its agent and old URLs, and reports what was dropped', () => {
    const out = excludeWorkspaces(bundle(), ['Demo Workspace']);
    expect(out.workspaces.map((w) => w.workspace.id)).toEqual(['w1']);
    expect(out.agents.map((a) => a.workspaceId)).toEqual(['w1']);
    expect(out.oldUrls.paths.map((p) => p.path)).toEqual(['/workspace/w1/w1-d0', '/invite/x']);
    expect(out.published).toHaveLength(1);
    expect(out.signupAllowlist).toEqual(bundle().signupAllowlist);
    expect(out.excluded).toEqual([
      {
        id: 'demo',
        name: 'Demo Workspace',
        members: ['a@x:owner'],
        docs: 2,
        trashedDocs: 1,
        folders: 1,
        databases: 1,
        publishedDocs: 0,
        comments: 0,
        translations: 0,
        blobs: 2,
        blobBytes: 30,
        docGrants: 1,
        oldUrls: 2,
        agents: 1,
      },
    ]);
  });

  it('matches by AFFiNE id too, and leaves the bundle as is when nothing matches', () => {
    expect(excludeWorkspaces(bundle(), ['demo']).workspaces).toHaveLength(1);
    const same = bundle();
    expect(excludeWorkspaces(same, ['Nope'])).toBe(same);
    expect(excludeWorkspaces(same, [])).toBe(same);
  });
});

describe('parseExcludeList (--exclude-workspaces)', () => {
  it('defaults to the Demo Workspace, accepts a list and "none"', () => {
    expect(parseExcludeList(undefined)).toEqual(['Demo Workspace']);
    expect(parseExcludeList('A, B')).toEqual(['A', 'B']);
    expect(parseExcludeList('none')).toEqual([]);
  });
});
