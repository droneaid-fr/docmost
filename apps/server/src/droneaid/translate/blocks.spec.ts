import {
  createDatabaseData,
  databaseToJson,
  DATABASE_NODE,
} from '@docmost/editor-ext';
import { htmlToJson, jsonToNode } from '../../collaboration/collaboration.util';
import { targetListSpec } from '../database/database-fixtures';
import { extractBlocks, sourceHash, stripCommentMarks } from './blocks';
import { translatePage } from './translation.worker';
import { fakeGenerate } from './translate.testing';

const IMAGE_ID = '0190a000-0000-7000-8000-000000000001';

function richDoc() {
  const html = `
<h2>alpha heading</h2>
<p>alpha <strong>beta</strong> <a href="https://example.org/x">alpha link</a> <code>alpha</code> <mark>alpha</mark> <span data-type="mention" data-id="m1" data-entity-type="page" data-entity-id="p1" data-label="Other page">Other page</span> <span data-type="mathInline" data-katex="true">x^2</span> end</p>
<ul><li><p>alpha bullet</p><ul><li><p>beta nested</p></li></ul></li></ul>
<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>alpha task</p></li></ul>
<blockquote><p>alpha quote</p></blockquote>
<pre><code class="language-js">const alpha = 1;</code></pre>
<table><tbody><tr><th colspan="2"><p>alpha header</p></th></tr><tr><td><p>beta cell</p></td><td><p>alpha cell</p></td></tr></tbody></table>
<div data-type="callout" data-callout-type="warning"><p>alpha callout</p></div>
<details><summary>alpha summary</summary><div data-type="detailsContent"><p>beta details</p></div></details>
<img src="/api/files/${IMAGE_ID}/a.png" data-attachment-id="${IMAGE_ID}" width="300">
<div data-type="mathBlock" data-katex="true">E=mc^2</div>
<div data-type="columns"><div data-type="column"><p>alpha left</p></div><div data-type="column"><p>beta right</p></div></div>
<div data-type="attachment" data-attachment-url="/api/files/x/f.pdf" data-attachment-name="f.pdf"></div>
<div data-type="embed" data-src="https://www.youtube.com/embed/x" data-provider="youtube"></div>
<p><span data-type="mention" data-id="m2" data-entity-type="page" data-entity-id="p2" data-label="Only">Only</span></p>
<p>alpha line one<br>beta line two</p>
`;
  const doc = htmlToJson(html);
  const db = databaseToJson(createDatabaseData(targetListSpec(3)));
  return {
    ...doc,
    content: [...doc.content.slice(0, 3), db, ...doc.content.slice(3)],
  };
}

const types = (node: any, out: string[] = []) => {
  if (node?.type) out.push(node.type);
  (node?.content ?? []).forEach((c: any) => types(c, out));
  return out;
};
const find = (node: any, type: string): any[] =>
  [
    node?.type === type ? [node] : [],
    ...(node?.content ?? []).map((c: any) => find(c, type)),
  ].flat(2);
const text = (node: any): string =>
  node?.type === 'text' ? node.text : (node?.content ?? []).map(text).join('');

describe('page translation (blocks)', () => {
  it('extracts one block per text block, skipping code and placeholder-only text', () => {
    const { blocks, inline } = extractBlocks(richDoc());
    expect(blocks[0]).toBe('## alpha heading');
    expect(blocks.some((b) => b.includes('const alpha'))).toBe(false);
    expect(blocks).toContain('alpha header');
    expect(blocks).toContain('alpha summary');
    expect([...inline.values()].map((n) => n.type).sort()).toEqual([
      'mathInline',
      'mention',
    ]);
    expect(blocks.join('\n')).not.toContain('Organisation');
  });

  it('translates the text and keeps every other node, attribute and the database', async () => {
    const source = richDoc();
    const { title, content } = await translatePage({
      title: 'alpha title',
      content: source,
      from: 'en',
      to: 'fr',
      generate: fakeGenerate,
    });
    expect(title).toBe('ALFA title');
    expect(() => jsonToNode(content).check()).not.toThrow();
    // Same node types, in the same order: nothing dropped, nothing added.
    expect(types(content)).toEqual(types(source));

    // The database is byte-for-byte the original.
    expect(find(content, DATABASE_NODE)).toEqual(find(source, DATABASE_NODE));
    // Images, files, embeds and math blocks keep all their attributes.
    for (const type of [
      'image',
      'attachment',
      'embed',
      'mathBlock',
      'codeBlock',
      'mention',
      'mathInline',
    ]) {
      expect(find(content, type)).toEqual(find(source, type));
    }
    // Table cell attributes (colspan) survive.
    expect(find(content, 'tableHeader')[0].attrs).toEqual(
      find(source, 'tableHeader')[0].attrs,
    );
    expect(find(content, 'callout')[0].attrs).toEqual(
      find(source, 'callout')[0].attrs,
    );

    const all = text(content);
    expect(all).toContain('ALFA heading');
    expect(all).toContain('BETA nested');
    expect(all).toContain('ALFA left');
    expect(all).toContain('ALFA header');
    expect(all).toContain('ALFA summary');
    expect(all).toContain('const alpha = 1;');

    const para = content.content[1];
    const marks = para.content.flatMap((n: any) =>
      (n.marks ?? []).map((m: any) => m.type),
    );
    expect(marks).toEqual(
      expect.arrayContaining(['bold', 'link', 'code', 'highlight']),
    );
    const link = para.content.find((n: any) =>
      n.marks?.some((m: any) => m.type === 'link'),
    );
    expect(link.text).toBe('ALFA link');
    expect(link.marks.find((m: any) => m.type === 'link').attrs.href).toBe(
      'https://example.org/x',
    );
    // Inline nodes come back where they were.
    expect(para.content.map((n: any) => n.type)).toContain('mention');
    // Line breaks survive.
    expect(find(content, 'hardBreak')).toHaveLength(1);
    // Block ids are the source's.
    expect(content.content[0].attrs.id).toBe(source.content[0].attrs.id);
  });

  it('returns the page unchanged when there is nothing to translate', async () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph' }] };
    const generate = jest.fn();
    const out = await translatePage({
      title: '',
      content: doc,
      from: 'en',
      to: 'fr',
      generate,
    });
    expect(out.content).toEqual(doc);
    expect(generate).not.toHaveBeenCalled();
  });

  it('hashes content without comment marks', () => {
    const doc = htmlToJson('<p>alpha</p>');
    const commented = {
      ...doc,
      content: [
        {
          ...doc.content[0],
          content: [
            {
              type: 'text',
              text: 'alpha',
              marks: [{ type: 'comment', attrs: { commentId: 'c' } }],
            },
          ],
        },
      ],
    };
    expect(stripCommentMarks(commented)).toEqual(doc);
    expect(sourceHash('t', commented)).toBe(sourceHash('t', doc));
    expect(sourceHash('t', doc)).not.toBe(sourceHash('t2', doc));
  });

  it('ignores block ids and attribute defaults the editor adds, not text changes', () => {
    const bare = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'alpha' }] },
      ],
    };
    const opened = htmlToJson('<p>alpha</p>'); // ids and defaults filled in
    expect(JSON.stringify(opened)).not.toBe(JSON.stringify(bare));
    expect(sourceHash('t', opened)).toBe(sourceHash('t', bare));
    expect(sourceHash('t', htmlToJson('<p>alpha!</p>'))).not.toBe(
      sourceHash('t', bare),
    );
  });
});
