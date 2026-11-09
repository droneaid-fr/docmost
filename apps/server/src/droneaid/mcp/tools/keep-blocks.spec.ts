import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import {
  createDatabaseData,
  databaseToJson,
  markdownToHtml,
} from '@docmost/editor-ext';
import {
  htmlToJson,
  jsonToMarkdown,
  tiptapExtensions,
} from '../../../collaboration/collaboration.util';
import { addRows, readDatabase, updateRows } from '../../database';
import {
  collectKept,
  composeWithKept,
  dropTokens,
  KEEP_TOKEN,
  markersToTokens,
  normalizeUrl,
  restoreImageAttrs,
} from './keep-blocks';
import { liveJson, replaceFragment } from './live-doc';

const BASE = 'https://base.example';
const p = (text: string) => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});
const linkP = (text: string, href: string) => ({
  type: 'paragraph',
  content: [{ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }],
});
const token = (id: string) => p(`${KEEP_TOKEN}:database:${id}`);
const doc = (...content: any[]) => ({ type: 'doc', content });

const db = createDatabaseData({
  title: 'Guests',
  columns: [
    { name: 'Name', type: 'title' },
    { name: 'Blacklisted', type: 'checkbox' },
  ],
  rows: [{ Name: 'Ada', Blacklisted: true }, { Name: 'Bob' }],
});
const dbNode = databaseToJson(db);
const video = {
  type: 'video',
  attrs: { src: '/api/files/v1/clip.mp4', attachmentId: 'v1', width: 640 },
};
const attachment = {
  type: 'attachment',
  attrs: { url: '/api/files/a1/report.pdf', name: 'report.pdf', attachmentId: 'a1' },
};

async function parse(markdown: string) {
  return htmlToJson(await markdownToHtml(markersToTokens(markdown)));
}

describe('markersToTokens', () => {
  it('turns marker lines into tokens, not inside code fences', () => {
    const out = markersToTokens(
      'a\n<!-- database id=abc_1 -->\n```\n<!-- database id=nope -->\n```\n',
    );
    expect(out).toContain(`${KEEP_TOKEN}:database:abc_1`);
    expect(out).toContain('<!-- database id=nope -->');
  });

  it('accepts the long marker read_document writes', () => {
    const out = markersToTokens(
      'a\n<!-- database id=abc "Guests" (12 rows, 5 columns): read it with read_database. -->\nb',
    );
    expect(out).toContain(`${KEEP_TOKEN}:database:abc\n`);
    expect(out).not.toContain('<!--');
    expect(markersToTokens('<!-- database id=abc-->x -->')).not.toContain(KEEP_TOKEN);
  });
});

describe('normalizeUrl', () => {
  it('strips our origin, query and fragment', () => {
    expect(normalizeUrl(`${BASE}/api/files/x/a%20b.png?x=1`, BASE)).toBe(
      '/api/files/x/a b.png',
    );
    expect(normalizeUrl('', BASE)).toBeNull();
  });
});

describe('composeWithKept', () => {
  const current = doc(p('Intro'), dbNode, p('Middle'), video, p('Outro'));

  it('collects kept blocks with keys and anchors', () => {
    const kept = collectKept(current, BASE);
    expect(kept.map((k) => [k.type, k.key, k.anchor])).toEqual([
      ['droneaidDatabase', `database:${db.id}`, 'Intro'],
      ['video', '/api/files/v1/clip.mp4', 'Middle'],
    ]);
  });

  it('puts a database where its marker stands, from the live doc', () => {
    const { doc: out, kept } = composeWithKept(
      current,
      doc(p('New intro'), token(db.id), p('After')),
      BASE,
    );
    expect(out.content[1]).toBe(dbNode);
    expect(kept).toContainEqual({
      type: 'droneaidDatabase',
      id: db.id,
      placement: 'marker',
    });
  });

  it('keeps a database whose marker is missing, at the end', () => {
    const { doc: out, kept } = composeWithKept(
      current,
      doc(p('Only text')),
      BASE,
    );
    expect(out.content.map((n: any) => n.type)).toEqual([
      'paragraph',
      'droneaidDatabase',
      'video',
    ]);
    expect(kept[0].placement).toBe('end');
  });

  it('prefers the live database over a full Markdown export of it', () => {
    const copy = databaseToJson({ ...db, rows: [] });
    const { doc: out } = composeWithKept(current, doc(copy, copy), BASE);
    const dbs = out.content.filter((n: any) => n.type === 'droneaidDatabase');
    expect(dbs).toEqual([dbNode]);
  });

  it('creates a database whose id is new', () => {
    const other = databaseToJson(createDatabaseData({ title: 'New' }));
    const { doc: out } = composeWithKept(doc(p('x')), doc(other), BASE);
    expect(out.content[0]).toBe(other);
  });

  it('drops a marker for a database that is not in the page', () => {
    const { doc: out } = composeWithKept(doc(p('x')), doc(token('ghost')), BASE);
    expect(out.content).toEqual([{ type: 'paragraph' }]);
  });

  it('puts a file block where a line links to it', () => {
    const { doc: out, kept } = composeWithKept(
      current,
      doc(token(db.id), linkP('clip.mp4', `${BASE}/api/files/v1/clip.mp4`), p('x')),
      BASE,
    );
    expect(out.content[1]).toBe(video);
    expect(kept[1]).toEqual({ type: 'video', placement: 'link' });
  });

  it('anchors an unlinked file block after the paragraph it followed', () => {
    const { doc: out, kept } = composeWithKept(
      current,
      doc(p('Middle'), p('New'), token(db.id)),
      BASE,
    );
    expect(out.content.map((n: any) => n.type)).toEqual([
      'paragraph',
      'video',
      'paragraph',
      'droneaidDatabase',
    ]);
    expect(kept[1].placement).toBe('anchor');
  });

  it('keeps blocks nested in containers', () => {
    const nested = doc({
      type: 'callout',
      attrs: { type: 'info' },
      content: [p('Note'), attachment],
    });
    const { doc: out } = composeWithKept(nested, doc(p('Replaced')), BASE);
    expect(out.content[1]).toBe(attachment);
  });

  it('appends before a trailing footnotes block', () => {
    const footnotes = { type: 'footnotes', content: [] };
    const { doc: out } = composeWithKept(current, doc(p('a'), footnotes), BASE);
    expect(out.content[out.content.length - 1]).toEqual(footnotes);
  });

  it('finds file blocks in the Markdown read_document produces', async () => {
    const markdown = jsonToMarkdown(doc(p('Intro'), video, attachment));
    const { kept } = composeWithKept(
      doc(p('Intro'), video, attachment),
      await parse(markdown),
      '',
    );
    expect(kept.map((k) => k.placement)).toEqual(['link', 'link']);
  });
});

describe('restoreImageAttrs / dropTokens', () => {
  it('gives a known image its old attributes back', () => {
    const old = {
      type: 'image',
      attrs: { src: '/api/files/i1/a.png', width: 300, align: 'left', attachmentId: 'i1' },
    };
    const out = restoreImageAttrs(
      doc(old),
      doc({ type: 'image', attrs: { src: `${BASE}/api/files/i1/a.png`, alt: 'A' } }),
      BASE,
    );
    expect(out.content[0].attrs).toEqual({ ...old.attrs, alt: 'A' });
  });

  it('drops tokens and never leaves an empty doc', () => {
    expect(dropTokens(doc(token('x')))).toEqual(doc({ type: 'paragraph' }));
  });
});

describe('replaceFragment (live Y.Doc)', () => {
  const initial = doc(p('Intro'), dbNode, p('Outro'));

  function ydocOf(json: any) {
    return TiptapTransformer.toYdoc(json, 'default', tiptapExtensions);
  }
  function dbElement(ydoc: Y.Doc) {
    return ydoc
      .getXmlFragment('default')
      .toArray()
      .find((e: any) => e.nodeName === 'droneaidDatabase');
  }

  it('keeps the database element itself (Yjs identity) when kept in place', async () => {
    const ydoc = ydocOf(initial);
    const before = dbElement(ydoc);
    const { doc: next } = composeWithKept(
      liveJson(ydoc),
      await parse(`New intro\n\n<!-- database id=${db.id} -->\n\nNew outro`),
    );
    replaceFragment(ydoc, next);
    expect(dbElement(ydoc)).toBe(before);
    expect(readDatabase(ydoc)).toEqual(db);
    const texts = ydoc
      .getXmlFragment('default')
      .toArray()
      .map((e: any) => e.toString());
    expect(texts[0]).toContain('New intro');
    expect(texts[2]).toContain('New outro');
  });

  it('merges a concurrent cell edit made by an editor during the update', async () => {
    const server = ydocOf(initial);
    const browser = new Y.Doc();
    Y.applyUpdate(browser, Y.encodeStateAsUpdate(server));

    // The browser edits a cell; the server rewrites the text meanwhile.
    updateRows(browser, db.id, [{ id: db.rows[1].id, values: { Blacklisted: true } }]);
    const { doc: next } = composeWithKept(
      liveJson(server),
      await parse(`Rewritten\n\n<!-- database id=${db.id} -->`),
    );
    replaceFragment(server, next);

    Y.applyUpdate(server, Y.encodeStateAsUpdate(browser));
    Y.applyUpdate(browser, Y.encodeStateAsUpdate(server));
    for (const side of [server, browser]) {
      const data = readDatabase(side);
      expect(data.rows.map((r) => r.cells)).toEqual([
        expect.objectContaining({ [db.columns[1].id]: true }),
        expect.objectContaining({ [db.columns[1].id]: true }),
      ]);
      expect(liveJson(side).content[0].content[0].text).toBe('Rewritten');
    }
  });

  it('keeps rows added while the agent edits elsewhere', async () => {
    const ydoc = ydocOf(initial);
    addRows(ydoc, db.id, [{ Name: 'Cleo' }]);
    const { doc: next } = composeWithKept(liveJson(ydoc), await parse('Only text'));
    replaceFragment(ydoc, next);
    expect(readDatabase(ydoc).rows.map((r) => r.cells[db.columns[0].id])).toEqual([
      'Ada',
      'Bob',
      'Cleo',
    ]);
  });
});
