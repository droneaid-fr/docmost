import { convertDatabase, optionColor, sameCell } from './database-convert';

let n = 0;
const freshId = () => `fresh${++n}`;

describe('convertDatabase', () => {
  const source = {
    databaseId: 'db1',
    title: 'Guests',
    rowCount: 3,
    columns: [
      { id: 'title', name: 'Title', type: 'title', data: {}, virtual: true },
      { id: 'c-text', name: 'email', type: 'rich-text', data: {} },
      { id: 'c-check', name: 'blacklisted', type: 'checkbox', data: {} },
      { id: 'c-num', name: 'count', type: 'number', data: {} },
      { id: 'c-date', name: 'when', type: 'date', data: {} },
      {
        id: 'c-sel',
        name: 'Status',
        type: 'select',
        data: { options: [{ id: 'o1', value: 'Todo', color: 'var(--affine-v2-chip-label-white)' }, { id: 'o2', value: 'Done', color: 'var(--affine-v2-chip-label-purple)' }] },
      },
      { id: 'c-multi', name: 'events', type: 'multi-select', data: { options: [] } },
      { id: 'c-mem', name: 'Owner', type: 'member', data: {} },
      { id: '', name: 'Dup', type: 'progress', data: {} },
    ],
    rows: [
      { id: 'r1', values: { title: 'Ann', 'c-text': 'a@x', 'c-check': true, 'c-num': 3, 'c-date': '2026-01-02', 'c-sel': 'Done', 'c-multi': ['E1, with comma', 'E2'], 'c-mem': '["u1"]' } },
      { id: 'r1', values: { title: 'Bob', 'c-check': false, 'c-text': '', 'c-num': 'abc', 'c-mem': '[]' } },
      { id: 'r3', values: {} },
    ],
    views: [{ mode: 'table', columns: [{ id: 'title', width: 260 }, { id: 'c-text', hide: true, width: 180 }] }],
  } as any;
  const result = convertDatabase(source, { people: new Map([['u1', 'Filipp']]), freshId });

  it('keeps ids, maps types and widths, renames duplicates', () => {
    const { data } = result;
    expect(data.id).toBe('db1');
    expect(data.columns.map((c) => [c.id, c.type, c.width])).toEqual([
      ['title', 'title', 260],
      ['c-text', 'text', 180],
      ['c-check', 'checkbox', null],
      ['c-num', 'number', null],
      ['c-date', 'date', null],
      ['c-sel', 'select', null],
      ['c-multi', 'multi-select', null],
      ['c-mem', 'text', null],
      ['fresh1', 'text', null],
    ]);
    expect(data.rows.map((r) => r.id)).toEqual(['r1', 'fresh2', 'r3']);
    expect(result.renamedIds).toEqual(['(empty)', 'r1']);
    expect(result.hiddenColumns).toEqual(['email']);
    expect(result.notes).toEqual(['column "Dup" of AFFiNE type progress stored as text']);
  });

  it('converts values and keeps select options with colours', () => {
    const [ann, bob] = result.data.rows;
    expect(ann.cells).toEqual({
      title: 'Ann',
      'c-text': 'a@x',
      'c-check': true,
      'c-num': 3,
      'c-date': '2026-01-02',
      'c-sel': 'Done',
      'c-multi': ['E1, with comma', 'E2'],
      'c-mem': 'Filipp',
    });
    expect(bob.cells).toEqual({ title: 'Bob' });
    expect(result.invalidCells).toEqual([{ rowId: 'r1', column: 'count', value: 'abc' }]);
    const status = result.data.columns.find((c) => c.id === 'c-sel');
    expect(status.options).toEqual([
      { label: 'Todo', color: 'gray' },
      { label: 'Done', color: 'violet' },
    ]);
    expect(result.data.columns.find((c) => c.id === 'c-multi').options.map((o) => o.label)).toEqual([
      'E1, with comma',
      'E2',
    ]);
  });

  it('compares bundle and stored values the way the dry run does', () => {
    expect(sameCell('', null)).toBe(true);
    expect(sameCell(false, undefined)).toBe(true);
    expect(sameCell(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameCell(3, '3')).toBe(true);
    expect(sameCell('x', 'y')).toBe(false);
    expect(optionColor('var(--affine-v2-chip-label-teal)', 0)).toBe('teal');
  });
});
