import { buildUrlMap, caddySnippet } from './url-map';

describe('buildUrlMap', () => {
  const targets = {
    page: (_ws: string, doc: string) => (doc === 'gone' ? null : `/s/sp/p/t-${doc}`),
    share: (_ws: string, doc: string) => `/share/k/p/t-${doc}`,
    space: (ws: string) => (ws === 'w1' ? '/s/sp' : null),
    blob: (_ws: string, key: string) => (key === 'k1' ? '/api/files/a1/x.png' : null),
  };
  const { mapped, unmapped } = buildUrlMap(
    [
      { kind: 'doc', path: '/workspace/w1/d1', workspaceId: 'w1', docId: 'd1', published: false },
      { kind: 'doc', path: '/workspace/w1/d2', workspaceId: 'w1', docId: 'd2', published: true },
      { kind: 'share-legacy', path: '/share/w1/d2', workspaceId: 'w1', docId: 'd2', published: true },
      { kind: 'doc', path: '/workspace/w1/gone', workspaceId: 'w1', docId: 'gone', published: false },
      { kind: 'workspace', path: '/workspace/w1/all', workspaceId: 'w1' },
      { kind: 'tag', path: '/workspace/w1/tag/t', workspaceId: 'w1' },
      { kind: 'blob', path: '/api/workspaces/w1/blobs/k1', workspaceId: 'w1', targetId: 'k1' },
      { kind: 'blob', path: '/api/workspaces/w1/blobs/k2', workspaceId: 'w1', targetId: 'k2' },
    ],
    targets,
  );

  it('maps docs to pages, published docs to shares, sections to the space', () => {
    expect(Object.fromEntries(mapped.map((m) => [m.from, m.to]))).toEqual({
      '/workspace/w1/d1': '/s/sp/p/t-d1',
      '/workspace/w1/d2': '/share/k/p/t-d2',
      '/share/w1/d2': '/share/k/p/t-d2',
      '/workspace/w1/all': '/s/sp',
      '/workspace/w1/tag/t': '/s/sp',
      '/api/workspaces/w1/blobs/k1': '/api/files/a1/x.png',
    });
    expect(unmapped.map((u) => u.from)).toEqual(['/api/workspaces/w1/blobs/k2', '/workspace/w1/gone']);
  });

  it('renders a Caddy snippet that keeps the query and spares Docmost share paths', () => {
    const snippet = caddySnippet(mapped);
    expect(snippet).toContain('"/workspace/w1/d1" "/s/sp/p/t-d1"');
    expect(snippet).toContain('redir @droneaid_mapped {droneaid_old_url}{?query} 301');
    expect(snippet).toContain('redir @droneaid_invite /login 302');
    expect(snippet).toContain('path_regexp ^/share/[0-9a-f-]{36}/[^/]+$');
    expect(snippet).not.toMatch(/path [^\n]*\/share\//);
  });
});
