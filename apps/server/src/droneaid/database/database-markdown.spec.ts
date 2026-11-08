import {
  createDatabaseData,
  databaseToJson,
  databaseToMarkdown,
  findDatabasesInJson,
  markdownToHtml,
  parseDatabaseMarkdown,
  splitTableLine,
} from '@docmost/editor-ext';
import {
  htmlToJson,
  jsonToHtml,
  jsonToMarkdown,
  jsonToText,
} from '../../collaboration/collaboration.util';
import { targetListSpec } from './database-fixtures';

function page(data: ReturnType<typeof createDatabaseData>) {
  return {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Before' }] },
      databaseToJson(data),
      { type: 'paragraph', content: [{ type: 'text', text: 'After' }] },
    ],
  };
}

describe('database markdown', () => {
  const data = createDatabaseData(targetListSpec(12));

  it('exports the block as a marker line and a GFM table of the rows', () => {
    const markdown = jsonToMarkdown(page(data));
    const lines = markdown.split('\n');
    const marker = lines.findIndex((l) => l.startsWith('<!-- droneaid:database {'));
    expect(marker).toBeGreaterThan(0);
    expect(lines[marker + 1]).toBe(
      '| Organisation | Notes | Staff | Status | Sectors | Next step | Priority | Website |',
    );
    expect(lines[marker + 2]).toBe('| --- | --- | --- | --- | --- | --- | --- | --- |');
    expect(lines[marker + 3]).toBe(
      '| Organisation 1 | Met at event #0; follow up \\| pipe |  | To contact | Health, Education |  | Yes | https://org1.example.org |',
    );
    expect(markdown).toContain('| Organisation 12 |');
    expect(markdown.indexOf('Before')).toBeLessThan(marker === -1 ? 0 : markdown.indexOf('<!--'));
    expect(markdown.trim().endsWith('After')).toBe(true);
  });

  it('round-trips through Markdown import with ids, types and values', () => {
    const markdown = jsonToMarkdown(page(data));
    const json = htmlToJson(markdownToHtml(markdown) as string);
    const [back] = findDatabasesInJson(json);
    expect(back).toEqual(data);
  });

  it('round-trips through HTML (clipboard, HTML export/import)', () => {
    const [back] = findDatabasesInJson(htmlToJson(jsonToHtml(page(data))));
    expect(back).toEqual(data);
  });

  it('puts the rows into the page text used by search', () => {
    const text = jsonToText(page(data));
    expect(text).toContain('Target List');
    expect(text).toContain('Organisation 7 |');
    expect(text).toContain('https://org1.example.org');
  });

  it('escapes pipes, backslashes and newlines in cells', () => {
    const db = createDatabaseData({ rows: [{ Name: 'a|b\\c\nd' }] });
    const md = databaseToMarkdown(db);
    expect(md.split('\n')[3]).toBe('| a\\|b\\\\c d |');
    expect(splitTableLine('| a\\|b\\\\c d | x |')).toEqual(['a|b\\c d', 'x']);
    const parsed = parseDatabaseMarkdown(md);
    expect(parsed.data.rows[0].cells[db.columns[0].id]).toBe('a|b\\c d');
  });

  it('keeps "-->" in names from closing the marker comment', () => {
    const db = createDatabaseData({ title: 'a --> b <c>', rows: [{ Name: 'x' }] });
    const md = databaseToMarkdown(db);
    expect(md.split('\n')[0]).not.toMatch(/-->.*-->/);
    expect(parseDatabaseMarkdown(md).data.title).toBe('a --> b <c>');
  });

  it('imports edited Markdown: new rows get ids, header renames apply', () => {
    const db = createDatabaseData({
      columns: [{ name: 'Done', type: 'checkbox' }, { name: 'Tag', type: 'select' }],
      rows: [{ Name: 'one' }],
    });
    const md = databaseToMarkdown(db).replace('| Name |', '| Title |') + '\n| two | yes | New |';
    const parsed = parseDatabaseMarkdown(md).data;
    expect(parsed.columns[0].name).toBe('Title');
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].id).toBe(db.rows[0].id);
    expect(parsed.rows[1].cells[db.columns[1].id]).toBe(true);
    expect(parsed.columns[2].options.map((o) => o.label)).toEqual(['New']);
  });

  it('leaves a table without a marker as a normal table', () => {
    const json = htmlToJson(markdownToHtml('| a | b |\n| --- | --- |\n| 1 | 2 |') as string);
    expect(findDatabasesInJson(json)).toHaveLength(0);
    expect(JSON.stringify(json)).toContain('"table"');
  });
});
