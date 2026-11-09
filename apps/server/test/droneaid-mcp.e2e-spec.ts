/**
 * Integration test of the DroneAid MCP module against a running server
 * (real Postgres, Redis, Fastify, core CASL). Start the server of the step
 * (README "Dev setup"), complete setup, then:
 *
 *   DRONEAID_E2E_URL=http://localhost:3300 \
 *   DRONEAID_E2E_EMAIL=admin@example.com DRONEAID_E2E_PASSWORD=... \
 *   pnpm test:e2e -- droneaid-mcp
 *
 * Skipped when DRONEAID_E2E_URL is not set. Creates its own agent and spaces.
 */
const BASE = process.env.DRONEAID_E2E_URL;
const describeIf = BASE ? describe : describe.skip;
const API = `${BASE}/api`;
const RUN = Date.now().toString(36);

async function login(): Promise<string> {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: process.env.DRONEAID_E2E_EMAIL,
      password: process.env.DRONEAID_E2E_PASSWORD,
    }),
  });
  const cookie = res.headers.get('set-cookie') ?? '';
  const match = /authToken=([^;]+)/.exec(cookie);
  if (!match) throw new Error(`login failed: ${res.status}`);
  return match[1];
}

async function api(token: string, path: string, body: unknown = {}) {
  const res = await fetch(`${API}/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  return { status: res.status, data: json.data };
}

let rpcId = 0;
async function rpc(token: string, method: string, params?: unknown) {
  const res = await fetch(`${API}/droneaid/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const text = await res.text();
  const payload = text.includes('data:')
    ? text
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5))
        .join('')
    : text;
  return { status: res.status, body: payload ? JSON.parse(payload) : null };
}

async function tool(token: string, name: string, args: unknown = {}) {
  const { body } = await rpc(token, 'tools/call', { name, arguments: args });
  const result = body.result;
  const text = result.content[0].text;
  return { isError: !!result.isError, text, json: () => JSON.parse(text) };
}

describeIf('DroneAid MCP (integration)', () => {
  let admin: string;
  let agentToken: string;
  let tokenId: string;
  let agentUserId: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    admin = await login();
    const agent = await api(admin, 'droneaid/agents/create', {
      name: `Agent ${RUN}`,
      spaceName: `Agent ${RUN}`,
      spaceSlug: `agent-${RUN}`,
    });
    expect(agent.status).toBe(200);
    agentUserId = agent.data.userId;
    ids.agentSpace = agent.data.spaceId;

    for (const name of ['shared', 'secret']) {
      const space = await api(admin, 'spaces/create', {
        name: `${name} ${RUN}`,
        slug: `${name}-${RUN}`,
      });
      ids[name] = space.data.id;
    }
    await api(admin, 'spaces/members/add', {
      spaceId: ids.shared,
      userIds: [agentUserId],
      groupIds: [],
      role: 'reader',
    });
    const spaces = await api(admin, 'spaces', {});
    ids.general = spaces.data.items.find((s: any) => s.slug === 'general').id;

    const page = async (spaceId: string, title: string, content: string) =>
      (
        await api(admin, 'pages/create', {
          spaceId,
          title,
          content,
          format: 'markdown',
        })
      ).data.id;
    const word = `zebra${RUN}`;
    ids.word = word;
    ids.sharedPage = await page(ids.shared, `Shared ${RUN}`, `shared ${word}`);
    ids.secretPage = await page(ids.secret, `Secret ${RUN}`, `secret ${word}`);
    ids.generalPage = await page(ids.general, `General ${RUN}`, `general ${word}`);
    ids.agentPage = await page(ids.agentSpace, `Mine ${RUN}`, `mine ${word}`);

    const minted = await api(admin, 'droneaid/agents/tokens/create', {
      agentUserId,
      name: 'e2e',
    });
    agentToken = minted.data.token;
    tokenId = minted.data.record.id;
  });

  it('lists the agent tools (S3a read, S3b write, S4c database)', async () => {
    const { body } = await rpc(agentToken, 'tools/list');
    expect(body.result.tools.map((t: any) => t.name).sort()).toEqual([
      'add_database_rows',
      'add_to_folder',
      'create_database',
      'create_document',
      'create_folder',
      'doc_search',
      'get_document_info',
      'list_documents',
      'list_folders',
      'move_folder_item',
      'read_database',
      'read_document',
      'remove_database_rows',
      'remove_from_folder',
      'rename_folder',
      'update_database_columns',
      'update_database_rows',
      'update_document',
      'update_document_meta',
      'upload_image',
    ]);
  });

  it('reads, lists and searches only the granted spaces', async () => {
    const read = await tool(agentToken, 'read_document', { docId: ids.sharedPage });
    expect(read.text).toContain(`# Shared ${RUN}`);

    for (const docId of [ids.secretPage, ids.generalPage]) {
      expect((await tool(agentToken, 'read_document', { docId })).isError).toBe(true);
    }

    const search = (await tool(agentToken, 'doc_search', { query: ids.word })).json();
    expect(search.hits.map((h: any) => h.doc_id).sort()).toEqual(
      [ids.sharedPage, ids.agentPage].sort(),
    );

    const folders = (await tool(agentToken, 'list_folders', {})).json();
    const slugs = folders.spaces.map((s: any) => s.slug);
    expect(slugs).toEqual(expect.arrayContaining([`agent-${RUN}`, `shared-${RUN}`]));
    expect(slugs).not.toContain(`secret-${RUN}`);
    expect(slugs).not.toContain('general');
  });

  it('may write only in its own space (Docmost ability), not on General via Everyone', async () => {
    const folders = (await tool(agentToken, 'list_folders', {})).json();
    const bySlug = Object.fromEntries(folders.spaces.map((s: any) => [s.slug, s.can_write]));
    expect(bySlug[`agent-${RUN}`]).toBe(true);
    expect(bySlug[`shared-${RUN}`]).toBe(false);

    const info = (await tool(agentToken, 'get_document_info', { docId: ids.agentPage })).json();
    expect(info.canEdit).toBe(true);
    const shared = (await tool(agentToken, 'get_document_info', { docId: ids.sharedPage })).json();
    expect(shared.canEdit).toBe(false);
  });

  it('drops an Everyone membership an admin adds, so General stays closed', async () => {
    const groups = await api(admin, 'groups', {});
    const everyone = groups.data.items.find((g: any) => g.isDefault);
    await api(admin, 'groups/members/add', {
      groupId: everyone.id,
      userIds: [agentUserId],
    });
    const read = await tool(agentToken, 'read_document', { docId: ids.generalPage });
    expect(read.isError).toBe(true);
    const members = await api(admin, 'groups/members', { groupId: everyone.id, limit: 100 });
    expect(members.data.items.map((u: any) => u.id)).not.toContain(agentUserId);
  });

  it('a human session JWT works on MCP; an agent token does not work on core routes', async () => {
    const { status } = await rpc(admin, 'tools/list');
    expect(status).toBe(200);
    expect((await api(agentToken, 'spaces', {})).status).toBe(401);
    const { status: noAuth } = await rpc('', 'tools/list');
    expect(noAuth).toBe(401);
  });

  it('takes bodies above the global 1 MiB limit on MCP only', async () => {
    const big = 'A'.repeat(5 * 1024 * 1024);
    const res = await rpc(agentToken, 'tools/call', {
      name: 'doc_search',
      arguments: { query: 'x' },
      _pad: big,
    });
    expect(res.status).toBe(200);
    const core = await fetch(`${API}/spaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
      body: JSON.stringify({ pad: big }),
    });
    expect(core.status).toBe(413);
  });

  it('refuses a revoked token', async () => {
    const revoked = await api(admin, 'droneaid/agents/tokens/revoke', { tokenId });
    expect(revoked.status).toBe(200);
    const { status } = await rpc(agentToken, 'tools/list');
    expect(status).toBe(401);
    const list = await api(admin, 'droneaid/agents', {});
    const mine = list.data.find((a: any) => a.userId === agentUserId);
    expect(mine.tokens[0].revokedAt).toBeTruthy();
    expect(mine.tokens[0].lastUsedAt).toBeTruthy();
    expect(JSON.stringify(list.data)).not.toContain(agentToken);
  });
});
