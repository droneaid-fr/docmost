import * as Y from 'yjs';
import { ForbiddenException } from '@nestjs/common';
import { Hocuspocus } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import {
  createDatabaseData,
  databaseToJson,
  findDatabasesInJson,
  htmlToMarkdown,
} from '@docmost/editor-ext';
import {
  jsonToHtml,
  tiptapExtensions,
} from '../../../collaboration/collaboration.util';
import { findDatabases, readDatabase } from '../../database';
import { targetListSpec } from '../../database/database-fixtures';
import { McpToolContext } from './context';
import { toolsForCaller } from './define';
import {
  addDatabaseRowsTool,
  createDatabaseTool,
  readDatabaseTool,
  removeDatabaseRowsTool,
  updateDatabaseColumnsTool,
  updateDatabaseRowsTool,
} from './databases';
import { createColumns } from './database-ops';
import { readDocumentTool } from './documents';
import { updateDocumentTool } from './document-write';
import { ALL_TOOLS } from './index';
import { liveJson } from './live-doc';
import { databaseMarker } from './markdown';

jest.mock('@sindresorhus/slugify', () => ({
  __esModule: true,
  default: (text: string) => text.toLowerCase().replace(/\s+/g, '-'),
}));

const BASE = 'https://base.example';
const SPACES = [
  { id: 'sp-agent', name: 'Agent Space', slug: 'agent' },
  { id: 'sp-shared', name: 'Shared', slug: 'shared' },
  { id: 'sp-general', name: 'General', slug: 'general' },
];
/** The agent: writer in its space, reader in Shared, nothing in General. */
const ROLES: Record<string, string> = {
  'sp-agent': 'writer',
  'sp-shared': 'reader',
};

/** The Guest list as SOUL.md describes it. */
const guests = createDatabaseData({
  title: 'Guests',
  columns: [
    { name: 'Name', type: 'title' },
    { name: 'Email', type: 'text' },
    { name: 'Status', type: 'select', options: ['Invited', 'Confirmed'] },
    { name: 'Visit', type: 'date' },
    { name: 'blacklisted', type: 'checkbox' },
  ],
  rows: Array.from({ length: 12 }, (_, i) => ({
    Name: `Guest ${i + 1}`,
    Email: `guest${i + 1}@example.org`,
    Status: i % 2 ? 'Confirmed' : 'Invited',
    Visit: i < 3 ? `2026-12-0${i + 1}` : null,
    blacklisted: i === 4 || i === 9,
  })),
});
const other = createDatabaseData({
  title: 'Budget',
  columns: [{ name: 'Item', type: 'title' }],
  rows: [{ Item: 'Props' }],
});

const para = (text: string) => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});
const doc = (...content: any[]) => ({ type: 'doc', content });

function setup(seed: Record<string, any> = {}) {
  const pages = new Map<string, any>(
    [
      ['p-agent', 'sp-agent', 'Guest list'],
      ['p-two', 'sp-agent', 'Two databases'],
      ['p-plain', 'sp-agent', 'Plain'],
      ['p-shared', 'sp-shared', 'Shared list'],
      ['p-gen', 'sp-general', 'Welcome'],
    ].map(([id, spaceId, title]) => [
      id,
      {
        id,
        slugId: `${id.replace(/-/g, '')}x`,
        title,
        spaceId,
        parentPageId: null,
        workspaceId: 'ws-1',
        deletedAt: null,
        content: seed[id] ?? doc(para('Empty')),
      },
    ]),
  );
  const find = (id: string) =>
    [...pages.values()].find((p) => p.id === id || p.slugId === id);

  // Loads `content` as PersistenceExtension does when ydoc is null, and
  // stores it back on disconnect (as onStoreDocument writes `content`).
  const hocuspocus = new Hocuspocus({
    quiet: true,
    extensions: [
      {
        async onLoadDocument({ documentName, document }: any) {
          const json = pages.get(documentName.split('.')[1])?.content;
          const ydoc = TiptapTransformer.toYdoc(json, 'default', tiptapExtensions);
          Y.applyUpdate(document, Y.encodeStateAsUpdate(ydoc));
        },
        async onStoreDocument({ documentName, document }: any) {
          const page = pages.get(documentName.split('.')[1]);
          page.content = TiptapTransformer.fromYdoc(document, 'default');
        },
      },
    ],
  } as any);

  const qb: any = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'execute') return async () => [];
        if (prop === 'executeTakeFirst') return async () => undefined;
        return () => qb;
      },
    },
  );
  const deps: any = {
    db: qb,
    pageRepo: { findById: jest.fn(async (id: string) => find(id)) },
    spaceRepo: {
      findById: jest.fn(async (id: string) => SPACES.find((s) => s.id === id)),
    },
    spaceMemberRepo: { getUserSpaceIds: jest.fn(async () => Object.keys(ROLES)) },
    pageAccess: {
      validateCanView: jest.fn(async (p: any) => {
        if (!ROLES[p.spaceId]) throw new ForbiddenException();
      }),
      validateCanEdit: jest.fn(async (p: any) => {
        if (ROLES[p.spaceId] !== 'writer') throw new ForbiddenException();
      }),
    },
    pagePermissionRepo: { hasRestrictedPagesInSpace: async () => false },
    pageService: { update: jest.fn(async (p: any) => p) },
    exportService: {
      turnPageMentionsToLinks: jest.fn(async (json: any) => json),
      // Core's exportPage, minus the title heading details.
      exportPage: jest.fn(async (_f: string, page: any) =>
        htmlToMarkdown(jsonToHtml(page.content)),
      ),
    },
    domainService: { getWorkspaceUrl: () => BASE },
    collaborationGateway: {
      hocuspocus,
      lockDocument: jest.fn(async () => undefined),
      openDirectConnection: (name: string, context: any) =>
        hocuspocus.openDirectConnection(name, context),
    },
    environmentService: { isCollabDisableRedis: () => false },
    attachmentRepo: { findById: async () => undefined },
    wsService: { emitToSpaceExceptUsers: jest.fn(async () => undefined) },
    generalQueue: { add: jest.fn(async () => undefined) },
  };
  const ctx = new McpToolContext(
    {
      user: { id: 'agent-1', name: 'Slavik' } as any,
      workspace: { id: 'ws-1' } as any,
      authType: 'droneaid_agent',
      isAgent: true,
      agentSpaceId: 'sp-agent',
    },
    deps,
  );
  const stored = (id: string) => pages.get(id).content;
  /** The page's databases as typed data (ignores schema-default noise). */
  const dbState = (id: string) => JSON.stringify(findDatabasesInJson(stored(id)));
  const storedDb = (id: string) =>
    findDatabases(TiptapTransformer.toYdoc(stored(id), 'default', tiptapExtensions));
  instances.push(hocuspocus);
  return { ctx, deps, pages, hocuspocus, stored, storedDb, dbState };
}

const instances: Hocuspocus[] = [];
afterAll(async () => {
  for (const instance of instances) {
    instance.closeConnections();
    await instance.flushPendingStores();
  }
});

const json = (result: any) => JSON.parse(result.content[0].text);
const text = (result: any) => result.content[0].text as string;
const seed = {
  'p-agent': doc(para('Intro'), databaseToJson(guests), para('Tail')),
  'p-two': doc(databaseToJson(guests), databaseToJson(other)),
  'p-shared': doc(databaseToJson(other)),
};

describe('database tool list', () => {
  it('lists the six database tools for agents, none named delete', () => {
    const names = toolsForCaller(ALL_TOOLS, true).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'read_database',
        'create_database',
        'add_database_rows',
        'update_database_rows',
        'remove_database_rows',
        'update_database_columns',
      ]),
    );
    expect(names.filter((n) => n.includes('database') && n.includes('delete'))).toEqual([]);
  });
});

describe('create_database', () => {
  it('appends a typed database: first column is the title, names made unique', async () => {
    const { ctx, storedDb } = setup();
    const reply = json(
      await createDatabaseTool.execute(
        {
          docId: 'p-plain',
          title: 'Guests',
          columns: [
            'Name',
            { name: 'When', type: 'date' },
            { name: 'Status', type: 'select' },
            { name: 'ok', type: 'checkbox' },
            { name: 'Seats', type: 'number' },
            { name: 'Notes', type: 'rich-text' },
            'notes',
            '',
          ],
          rows: [
            ['Ada', '2026-12-01', 'Invited', true, 3, 'first', 'x'],
            ['Bob', null, 'Maybe', 'no'],
          ],
        },
        ctx,
      ),
    );
    expect(reply).toMatchObject({
      success: true,
      docId: 'p-plain',
      rows: 2,
      columns: 8,
      renamedColumns: [
        { from: 'notes', to: 'notes (2)' },
        { from: '', to: 'Column 8' },
      ],
    });
    const [ref] = storedDb('p-plain');
    expect(ref.id).toBe(reply.databaseId);
    const data = readDatabase(ref.element.doc!);
    expect(data.title).toBe('Guests');
    expect(data.columns.map((c) => c.type)).toEqual([
      'title', 'date', 'select', 'checkbox', 'number', 'text', 'text', 'text',
    ]);
    const [status] = data.columns.filter((c) => c.name === 'Status');
    expect(status.options.map((o) => o.label)).toEqual(['Invited', 'Maybe']);
    expect(data.rows[0].cells).toMatchObject({
      [data.columns[1].id]: '2026-12-01',
      [data.columns[3].id]: true,
      [data.columns[4].id]: 3,
    });
  });

  it('refuses a bad value or a wide row and changes nothing', async () => {
    const { ctx, storedDb } = setup();
    const bad = await createDatabaseTool.execute(
      {
        docId: 'p-plain',
        columns: ['Name', { name: 'Seats', type: 'number' }],
        rows: [['a', 1], ['b', 'many']],
      },
      ctx,
    );
    expect(bad.isError).toBe(true);
    expect(text(bad)).toBe(
      'Nothing was changed. Row 2: Column "Seats": "many" is not a number',
    );
    const wide = await createDatabaseTool.execute(
      { docId: 'p-plain', columns: ['Name'], rows: [['a', 'b']] },
      ctx,
    );
    expect(text(wide)).toMatch(/Row 1 has more values than the 1 columns/);
    expect(storedDb('p-plain')).toHaveLength(0);
  });

  it('makes unique column names case-insensitively', () => {
    expect(createColumns(['A', 'a', 'A']).specs.map((s) => s.name)).toEqual([
      'A',
      'a (2)',
      'A (3)',
    ]);
  });

  it('takes a 777-row CSV-shaped import in one call', async () => {
    const { ctx, storedDb } = setup();
    const spec = targetListSpec(777);
    const header = spec.columns!.map((c) => c.name);
    const rows = spec.rows!.map((r) =>
      header.map((h) => {
        const v = r[h];
        return Array.isArray(v) ? v.join(', ') : v === null || v === undefined ? '' : String(v);
      }),
    );
    const reply = json(
      await createDatabaseTool.execute(
        { docId: 'p-plain', title: 'Target List', columns: header, rows },
        ctx,
      ),
    );
    expect(reply).toMatchObject({ success: true, rows: 777, columns: 8 });
    const data = readDatabase(storedDb('p-plain')[0].element.doc!);
    expect(data.rows).toHaveLength(777);
    expect(data.columns.slice(1).every((c) => c.type === 'text')).toBe(true);
  });
});

describe('read_database', () => {
  it('returns columns and a page of rows; checkbox values are explicit', async () => {
    const { ctx } = setup(seed);
    const reply = json(
      await readDatabaseTool.execute({ docId: 'p-agent', limit: 5 }, ctx),
    );
    expect(reply).toMatchObject({
      docId: 'p-agent',
      databaseId: guests.id,
      title: 'Guests',
      totalRows: 12,
      offset: 0,
      nextOffset: 5,
    });
    expect(reply.matchingRows).toBeUndefined();
    expect(reply.columns).toEqual([
      { id: guests.columns[0].id, name: 'Name', type: 'title' },
      { id: guests.columns[1].id, name: 'Email', type: 'text' },
      { id: guests.columns[2].id, name: 'Status', type: 'select', options: ['Invited', 'Confirmed'] },
      { id: guests.columns[3].id, name: 'Visit', type: 'date' },
      { id: guests.columns[4].id, name: 'blacklisted', type: 'checkbox' },
    ]);
    expect(reply.rows[0]).toEqual({
      id: guests.rows[0].id,
      values: {
        Name: 'Guest 1',
        Email: 'guest1@example.org',
        Status: 'Invited',
        Visit: '2026-12-01',
        blacklisted: false,
      },
    });
    expect(reply.rows[4].values).toMatchObject({ Name: 'Guest 5', blacklisted: true });
    expect(reply.rows[4].values.Visit).toBeUndefined(); // empty left out
  });

  it('pages to the end and searches every value', async () => {
    const { ctx } = setup(seed);
    const last = json(
      await readDatabaseTool.execute({ docId: 'p-agent', offset: 10, limit: 5 }, ctx),
    );
    expect(last.rows.map((r: any) => r.values.Name)).toEqual(['Guest 11', 'Guest 12']);
    expect(last.nextOffset).toBeUndefined();

    const found = json(
      await readDatabaseTool.execute({ docId: 'p-agent', search: 'GUEST10@' }, ctx),
    );
    expect(found).toMatchObject({ totalRows: 12, matchingRows: 1 });
    expect(found.rows[0]).toMatchObject({
      id: guests.rows[9].id,
      values: { Name: 'Guest 10', blacklisted: true },
    });

    const confirmed = json(
      await readDatabaseTool.execute(
        { docId: 'p-agent', search: 'confirmed', limit: 2, offset: 2 },
        ctx,
      ),
    );
    expect(confirmed).toMatchObject({ matchingRows: 6, offset: 2, nextOffset: 4 });
    expect(confirmed.rows.map((r: any) => r.values.Name)).toEqual(['Guest 6', 'Guest 8']);

    // "true" finds exactly the blacklisted guests; an unchecked box is not text.
    const blacklisted = json(
      await readDatabaseTool.execute({ docId: 'p-agent', search: 'true' }, ctx),
    );
    expect(blacklisted.rows.map((r: any) => r.values.Name)).toEqual(['Guest 5', 'Guest 10']);
    const none = json(
      await readDatabaseTool.execute({ docId: 'p-agent', search: 'false' }, ctx),
    );
    expect(none.matchingRows).toBe(0);
  });

  it('lists the databases when there are several and no id', async () => {
    const { ctx } = setup(seed);
    expect(json(await readDatabaseTool.execute({ docId: 'p-two' }, ctx))).toEqual({
      docId: 'p-two',
      databases: [
        { id: guests.id, title: 'Guests', rows: 12 },
        { id: other.id, title: 'Budget', rows: 1 },
      ],
    });
    const budget = json(
      await readDatabaseTool.execute({ docId: 'p-two', databaseId: other.id }, ctx),
    );
    expect(budget.rows[0].values).toEqual({ Item: 'Props' });
  });

  it('accepts a database title as databaseId, for reads and writes', async () => {
    const { ctx } = setup(seed);
    const budget = json(
      await readDatabaseTool.execute({ docId: 'p-two', databaseId: 'budget' }, ctx),
    );
    expect(budget.databaseId).toBe(other.id);
    const reply = json(
      await updateDatabaseRowsTool.execute(
        {
          docId: 'p-two',
          databaseId: 'Guests',
          updates: [{ rowId: guests.rows[0].id, values: { blacklisted: true } }],
        },
        ctx,
      ),
    );
    expect(reply).toMatchObject({ success: true, updatedRows: 1 });
  });

  it('reads the live doc while an editor holds unsaved changes', async () => {
    const { ctx, hocuspocus } = setup(seed);
    const editor = await hocuspocus.openDirectConnection('page.p-agent', {});
    // A cell edit not stored yet (no disconnect, so no onStoreDocument).
    const { element } = findDatabases(editor.document)[0];
    const row = element.toArray().find(
      (c: any) => c.nodeName === 'droneaidDatabaseRow',
    ) as Y.XmlElement;
    const emailCell = row
      .toArray()
      .find((c: any) => c.getAttribute('column') === guests.columns[1].id) as Y.XmlElement;
    editor.document.transact(() => emailCell.setAttribute('value', 'new@example.org'));
    const reply = json(
      await readDatabaseTool.execute({ docId: 'p-agent', limit: 1 }, ctx),
    );
    expect(reply.rows[0].values.Email).toBe('new@example.org');
    await editor.disconnect();
  });

  it('refuses unknown ids and documents without a database', async () => {
    const { ctx } = setup(seed);
    expect(text(await readDatabaseTool.execute({ docId: 'p-plain' }, ctx))).toBe(
      'This document has no database.',
    );
    expect(
      text(await readDatabaseTool.execute({ docId: 'p-agent', databaseId: 'nope' }, ctx)),
    ).toBe('Database nope not found in this document.');
    expect(text(await readDatabaseTool.execute({ docId: 'p-missing' }, ctx))).toBe(
      'Doc with id p-missing not found.',
    );
  });
});

describe('row tools', () => {
  it('adds rows (new select labels become options) and returns their ids', async () => {
    const { ctx, storedDb } = setup(seed);
    const reply = json(
      await addDatabaseRowsTool.execute(
        {
          docId: 'p-agent',
          rows: [
            { Name: 'Zoe', Status: 'Waitlist', Visit: '2027-01-05', blacklisted: 'yes' },
            { name: 'Yann' },
          ],
        },
        ctx,
      ),
    );
    expect(reply).toMatchObject({ success: true, docId: 'p-agent', databaseId: guests.id });
    expect(reply.rowIds).toHaveLength(2);
    const data = readDatabase(storedDb('p-agent')[0].element.doc!);
    expect(data.rows.slice(-2).map((r) => r.id)).toEqual(reply.rowIds);
    expect(data.columns[2].options.map((o) => o.label)).toEqual([
      'Invited',
      'Confirmed',
      'Waitlist',
    ]);
    const read = json(
      await readDatabaseTool.execute({ docId: 'p-agent', search: 'zoe' }, ctx),
    );
    expect(read.rows[0].values).toEqual({
      Name: 'Zoe',
      Status: 'Waitlist',
      Visit: '2027-01-05',
      blacklisted: true,
    });
  });

  it('adds nothing when one row has a bad value', async () => {
    const { ctx, dbState } = setup(seed);
    const before = dbState('p-agent');
    const result = await addDatabaseRowsTool.execute(
      { docId: 'p-agent', rows: [{ Name: 'ok' }, { Visit: 'someday' }] },
      ctx,
    );
    expect(text(result)).toBe(
      'Nothing was changed. Row 2: Column "Visit": "someday" is not a date (use YYYY-MM-DD)',
    );
    expect(dbState('p-agent')).toBe(before);
  });

  it('updates only the given cells; clears with null; ids stay', async () => {
    const { ctx } = setup(seed);
    const [a, b] = guests.rows;
    const reply = json(
      await updateDatabaseRowsTool.execute(
        {
          docId: 'p-agent',
          updates: [
            { rowId: a.id, values: { blacklisted: true, Visit: null } },
            { rowId: b.id, values: { Status: 'Invited', Email: 'b@x.org' } },
          ],
        },
        ctx,
      ),
    );
    expect(reply).toMatchObject({ success: true, updatedRows: 2 });
    const read = json(await readDatabaseTool.execute({ docId: 'p-agent', limit: 2 }, ctx));
    expect(read.rows).toEqual([
      {
        id: a.id,
        values: { Name: 'Guest 1', Email: 'guest1@example.org', Status: 'Invited', blacklisted: true },
      },
      {
        id: b.id,
        values: { Name: 'Guest 2', Email: 'b@x.org', Status: 'Invited', Visit: '2026-12-02', blacklisted: false },
      },
    ]);
  });

  it('refuses unknown rows, columns and values without changing anything', async () => {
    const { ctx, dbState } = setup(seed);
    const before = dbState('p-agent');
    const [a] = guests.rows;
    const missing = await updateDatabaseRowsTool.execute(
      { docId: 'p-agent', updates: [{ rowId: a.id, values: { Email: 'x' } }, { rowId: 'gone', values: {} }] },
      ctx,
    );
    expect(text(missing)).toBe(
      'Nothing was changed. Not rows of this database: gone. Read it again with read_database.',
    );
    const column = await updateDatabaseRowsTool.execute(
      { docId: 'p-agent', updates: [{ rowId: a.id, values: { Phone: '1' } }] },
      ctx,
    );
    expect(text(column)).toMatch(/^Nothing was changed\. Row \w+: Unknown column "Phone"/);
    const value = await updateDatabaseRowsTool.execute(
      {
        docId: 'p-agent',
        updates: [
          { rowId: a.id, values: { Email: 'changed' } },
          { rowId: guests.rows[1].id, values: { blacklisted: 'perhaps' } },
        ],
      },
      ctx,
    );
    expect(text(value)).toMatch(/is not yes or no/);
    expect(dbState('p-agent')).toBe(before);
  });

  it('removes rows, all or none', async () => {
    const { ctx } = setup(seed);
    const [a, b, c] = guests.rows;
    const refused = await removeDatabaseRowsTool.execute(
      { docId: 'p-agent', rowIds: [a.id, 'nope'] },
      ctx,
    );
    expect(text(refused)).toMatch(/^Nothing was changed\. Not rows of this database: nope\./);
    const reply = json(
      await removeDatabaseRowsTool.execute(
        { docId: 'p-agent', rowIds: [a.id, b.id, a.id] },
        ctx,
      ),
    );
    expect(reply).toMatchObject({ success: true, removedRows: 2 });
    const read = json(await readDatabaseTool.execute({ docId: 'p-agent', limit: 1 }, ctx));
    expect(read).toMatchObject({ totalRows: 10 });
    expect(read.rows[0].id).toBe(c.id);
  });

  it('asks for databaseId when the page has several', async () => {
    const { ctx } = setup(seed);
    const result = await addDatabaseRowsTool.execute(
      { docId: 'p-two', rows: [{ Name: 'x' }] },
      ctx,
    );
    expect(text(result)).toMatch(/^Nothing was changed\. This page has 2 databases; pass a databaseId/);
    const ok = json(
      await addDatabaseRowsTool.execute(
        { docId: 'p-two', databaseId: other.id, rows: [{ Item: 'Drone' }] },
        ctx,
      ),
    );
    expect(ok).toMatchObject({ success: true, databaseId: other.id });
  });
});

describe('update_database_columns', () => {
  it('adds, renames, retypes (text to select) and removes, in order', async () => {
    const { ctx } = setup(seed);
    const reply = json(
      await updateDatabaseColumnsTool.execute(
        {
          docId: 'p-agent',
          ops: [
            { op: 'add', name: 'Seats', type: 'number' },
            { op: 'rename', column: 'Name', name: 'Guest' },
            { op: 'set_type', column: 'Email', type: 'select' },
            { op: 'set_type', column: 'Status', type: 'number' },
            { op: 'remove', column: 'Visit' },
          ],
        },
        ctx,
      ),
    );
    expect(reply.success).toBe(true);
    expect(reply.columns).toEqual([
      { op: 'add', id: expect.any(String), name: 'Seats', type: 'number' },
      { op: 'rename', id: guests.columns[0].id, name: 'Guest' },
      {
        op: 'set_type', id: guests.columns[1].id, name: 'Email',
        from: 'text', to: 'select', valuesThatDidNotConvert: 0,
      },
      {
        op: 'set_type', id: guests.columns[2].id, name: 'Status',
        from: 'select', to: 'number', valuesThatDidNotConvert: 12,
      },
      { op: 'remove', id: guests.columns[3].id, name: 'Visit' },
    ]);
    const read = json(await readDatabaseTool.execute({ docId: 'p-agent', limit: 1 }, ctx));
    expect(read.columns.map((c: any) => [c.name, c.type])).toEqual([
      ['Guest', 'title'],
      ['Email', 'select'],
      ['Status', 'number'],
      ['blacklisted', 'checkbox'],
      ['Seats', 'number'],
    ]);
    expect(read.columns[1].options).toHaveLength(12);
    expect(read.rows[0].values).toEqual({
      Guest: 'Guest 1',
      Email: 'guest1@example.org',
      blacklisted: false,
    });
  });

  it('applies no op when a later one fails', async () => {
    const { ctx, dbState } = setup(seed);
    const before = dbState('p-agent');
    const result = await updateDatabaseColumnsTool.execute(
      {
        docId: 'p-agent',
        ops: [
          { op: 'add', name: 'Seats', type: 'number' },
          { op: 'rename', column: 'Email', name: 'Mail' },
          { op: 'remove', column: 'Name' },
        ],
      },
      ctx,
    );
    expect(text(result)).toBe(
      'Nothing was changed. Op 3 (remove): The title column cannot be removed.',
    );
    expect(dbState('p-agent')).toBe(before);
    const clash = await updateDatabaseColumnsTool.execute(
      { docId: 'p-agent', ops: [{ op: 'add', name: 'email', type: 'text' }] },
      ctx,
    );
    expect(text(clash)).toMatch(/A column named "Email" exists/);
    const retitle = await updateDatabaseColumnsTool.execute(
      { docId: 'p-agent', ops: [{ op: 'set_type', column: 'Name', type: 'text' }] },
      ctx,
    );
    expect(text(retitle)).toMatch(/title column cannot be retyped/);
    expect(dbState('p-agent')).toBe(before);
  });
});

describe('permissions', () => {
  it('lets a reader read but not write', async () => {
    const { ctx, stored } = setup(seed);
    const read = json(await readDatabaseTool.execute({ docId: 'p-shared' }, ctx));
    expect(read.rows[0].values).toEqual({ Item: 'Props' });
    const before = JSON.stringify(stored('p-shared'));
    const writes = [
      await addDatabaseRowsTool.execute({ docId: 'p-shared', rows: [{ Item: 'x' }] }, ctx),
      await updateDatabaseRowsTool.execute(
        { docId: 'p-shared', updates: [{ rowId: other.rows[0].id, values: { Item: 'y' } }] },
        ctx,
      ),
      await removeDatabaseRowsTool.execute({ docId: 'p-shared', rowIds: [other.rows[0].id] }, ctx),
      await updateDatabaseColumnsTool.execute(
        { docId: 'p-shared', ops: [{ op: 'add', name: 'N', type: 'number' }] },
        ctx,
      ),
      await createDatabaseTool.execute({ docId: 'p-shared', columns: ['A'], rows: [] }, ctx),
    ];
    for (const result of writes) {
      expect(result.isError).toBe(true);
      expect(text(result)).toBe(
        'You cannot edit document p-shared: you only have read access to it.',
      );
    }
    expect(JSON.stringify(stored('p-shared'))).toBe(before);
  });

  it('treats General (no membership) as not found', async () => {
    const { ctx } = setup(seed);
    for (const result of [
      await readDatabaseTool.execute({ docId: 'p-gen' }, ctx),
      await addDatabaseRowsTool.execute({ docId: 'p-gen', rows: [{ a: 1 }] }, ctx),
      await createDatabaseTool.execute({ docId: 'p-gen', columns: ['A'], rows: [] }, ctx),
    ]) {
      expect(text(result)).toBe('Doc with id p-gen not found.');
    }
  });
});

describe('read_document marker round trip', () => {
  it('shows one marker line per database, and a moved marker moves it', async () => {
    const { ctx, hocuspocus, stored } = setup(seed);
    const markdown = text(await readDocumentTool.execute({ docId: 'p-agent' }, ctx));
    const marker = databaseMarker({ id: guests.id, title: 'Guests', rows: 12, columns: 5 });
    expect(marker).toMatch(/^<!-- database id=\w+ "Guests" \(12 rows, 5 columns\): .* -->$/);
    expect(markdown.split('\n').filter((l) => l.includes('database'))).toEqual([marker]);
    expect(markdown).not.toContain('guest1@example.org'); // no table, just the marker
    expect(markdown.indexOf('Intro')).toBeLessThan(markdown.indexOf(marker));
    expect(markdown.indexOf(marker)).toBeLessThan(markdown.indexOf('Tail'));

    // An open editor watches; the agent moves the marker below "Tail".
    const editor = await hocuspocus.openDirectConnection('page.p-agent', {});
    const moved = markdown.replace(`${marker}\n`, '').replace('Tail', `Tail\n\n${marker}\n\nAfter`);
    const reply = json(
      await updateDocumentTool.execute({ docId: 'p-agent', content: moved }, ctx),
    );
    expect(reply.kept).toEqual([
      { type: 'droneaidDatabase', id: guests.id, placement: 'marker' },
    ]);
    const live = liveJson(editor.document);
    expect(live.content.map((n: any) => n.type)).toEqual([
      'paragraph',
      'paragraph',
      'droneaidDatabase',
      'paragraph',
    ]);
    expect(readDatabase(editor.document)).toEqual(guests);
    await editor.disconnect();
    expect(readDatabase(TiptapTransformer.toYdoc(stored('p-agent'), 'default', tiptapExtensions))).toEqual(guests);
  });
});
