import {
  DatabaseColumn,
  DatabaseError,
  cellText,
  compareValues,
  convertValue,
  createDatabaseData,
  optionsWith,
  queryRows,
  readCellValue,
  readOptions,
  resolveColumn,
  toCellValue,
  toIsoDate,
} from '@docmost/editor-ext';

const col = (type: DatabaseColumn['type'], extra: Partial<DatabaseColumn> = {}) =>
  ({ id: type, name: type, type, options: [], width: null, ...extra }) as DatabaseColumn;

describe('database values', () => {
  it('treats null and undefined as empty for every type', () => {
    for (const type of [
      'title', 'text', 'number', 'select', 'multi-select', 'date', 'checkbox', 'link',
    ] as const) {
      expect(toCellValue(col(type), null)).toBeNull();
      expect(toCellValue(col(type), undefined)).toBeNull();
    }
  });

  it('stores text as strings', () => {
    expect(toCellValue(col('text'), 'hello')).toBe('hello');
    expect(toCellValue(col('title'), 42)).toBe('42');
    expect(toCellValue(col('text'), ['a', 'b'])).toBe('a, b');
    expect(toCellValue(col('text'), '')).toBeNull();
  });

  it('parses numbers strictly, with decimal commas and thousands separators', () => {
    const number = col('number');
    expect(toCellValue(number, 3.5)).toBe(3.5);
    expect(toCellValue(number, ' 12 ')).toBe(12);
    expect(toCellValue(number, '1,5')).toBe(1.5);
    expect(toCellValue(number, '1,234.5')).toBe(1234.5);
    expect(toCellValue(number, '1 234')).toBe(1234);
    expect(toCellValue(number, '')).toBeNull();
    expect(() => toCellValue(number, 'abc')).toThrow(DatabaseError);
    expect(() => toCellValue(number, '12kg')).toThrow(/not a number/);
    expect(() => toCellValue(number, Infinity)).toThrow(DatabaseError);
    expect(toCellValue(number, '12kg', true)).toBe(12);
    expect(toCellValue(number, 'abc', true)).toBeNull();
  });

  it('stores checkbox as true or empty', () => {
    const box = col('checkbox');
    expect(toCellValue(box, true)).toBe(true);
    expect(toCellValue(box, false)).toBeNull();
    for (const yes of ['yes', 'Yes', 'x', 'true', '1', '✓', 'oui']) {
      expect(toCellValue(box, yes)).toBe(true);
    }
    for (const no of ['no', 'false', '0', '', 'non']) {
      expect(toCellValue(box, no)).toBeNull();
    }
    expect(() => toCellValue(box, 'maybe')).toThrow(/yes or no/);
    expect(toCellValue(box, 'maybe', true)).toBeNull();
  });

  it('stores dates as YYYY-MM-DD', () => {
    const date = col('date');
    expect(toCellValue(date, '2026-11-08')).toBe('2026-11-08');
    expect(toCellValue(date, '2026-11-08T23:30:00Z')).toBe('2026-11-08');
    expect(toCellValue(date, Date.UTC(2026, 10, 8))).toBe('2026-11-08');
    // AFFiNE: local midnight in Paris is 23:00 UTC the day before.
    expect(toCellValue(date, Date.UTC(2026, 10, 7, 23))).toBe('2026-11-08');
    expect(toCellValue(date, 'November 8, 2026')).toBe('2026-11-08');
    expect(() => toCellValue(date, '2026-02-30')).toThrow(/not a date/);
    expect(() => toCellValue(date, 'soon')).toThrow(DatabaseError);
    expect(toCellValue(date, 'soon', true)).toBeNull();
    expect(toIsoDate('')).toBeNull();
  });

  it('validates links and adds https to bare domains', () => {
    const link = col('link');
    expect(toCellValue(link, 'https://drone-aid.fr/x')).toBe('https://drone-aid.fr/x');
    expect(toCellValue(link, 'drone-aid.fr')).toBe('https://drone-aid.fr');
    expect(toCellValue(link, 'mailto:a@b.fr')).toBe('mailto:a@b.fr');
    expect(() => toCellValue(link, 'not a link')).toThrow(/not a link/);
    expect(toCellValue(link, 'not a link', true)).toBeNull();
  });

  it('stores select labels and multi-select label lists', () => {
    expect(toCellValue(col('select'), ' Done ')).toBe('Done');
    expect(toCellValue(col('select'), ['A', 'B'])).toBe('A');
    expect(toCellValue(col('select'), '')).toBeNull();
    expect(toCellValue(col('multi-select'), 'a, b, a')).toEqual(['a', 'b']);
    expect(toCellValue(col('multi-select'), ['x', ' y '])).toEqual(['x', 'y']);
    expect(toCellValue(col('multi-select'), [])).toBeNull();
  });

  it('reads stored garbage defensively', () => {
    expect(readCellValue(col('number'), 'oops')).toBeNull();
    expect(readCellValue(col('number'), '7')).toBe(7);
    expect(readCellValue(col('date'), {})).toBeNull();
    expect(readOptions([{ label: 'a', color: 'red' }, 'b', { label: 'a' }, 3])).toEqual([
      { label: 'a', color: 'red' },
      { label: 'b', color: 'blue' },
    ]);
  });

  it('formats values as text', () => {
    expect(cellText(null)).toBe('');
    expect(cellText(true)).toBe('Yes');
    expect(cellText(['a', 'b'])).toBe('a, b');
    expect(cellText(3)).toBe('3');
  });

  it('converts values between types', () => {
    expect(convertValue(col('text'), col('number'), '42')).toBe(42);
    expect(convertValue(col('text'), col('number'), 'n/a')).toBeNull();
    expect(convertValue(col('number'), col('text'), 42)).toBe('42');
    expect(convertValue(col('multi-select'), col('select'), ['a', 'b'])).toBe('a');
    expect(convertValue(col('select'), col('multi-select'), 'a')).toEqual(['a']);
    expect(convertValue(col('text'), col('multi-select'), 'a, b')).toEqual(['a', 'b']);
    expect(convertValue(col('checkbox'), col('text'), true)).toBe('Yes');
    expect(convertValue(col('checkbox'), col('number'), true)).toBe(1);
    expect(convertValue(col('date'), col('text'), '2026-01-02')).toBe('2026-01-02');
  });

  it('adds new option labels with palette colours, keeping identity when unchanged', () => {
    const options = [{ label: 'a', color: 'gray' as const }];
    expect(optionsWith(options, ['a'])).toBe(options);
    expect(optionsWith(options, ['b', 'b'])).toEqual([
      { label: 'a', color: 'gray' },
      { label: 'b', color: 'blue' },
    ]);
  });

  it('sorts empty values last and numbers numerically', () => {
    const number = col('number');
    const sorted = [3, null, 10, 2].sort((a, b) => compareValues(number, a, b));
    expect(sorted).toEqual([2, 3, 10, null]);
  });
});

describe('database model', () => {
  it('creates a database with a title column and validated rows', () => {
    const data = createDatabaseData({
      title: 'T',
      columns: [{ name: 'Status', type: 'select' }],
      rows: [{ Name: 'one', status: 'Open' }, { Name: 'two' }],
    });
    expect(data.columns.map((c) => [c.name, c.type])).toEqual([
      ['Name', 'title'],
      ['Status', 'select'],
    ]);
    expect(data.columns[1].options.map((o) => o.label)).toEqual(['Open']);
    expect(data.rows).toHaveLength(2);
    expect(new Set(data.rows.map((r) => r.id)).size).toBe(2);
  });

  it('rejects bad specs', () => {
    expect(() =>
      createDatabaseData({ columns: [{ name: 'A', type: 'title' }, { name: 'B', type: 'title' }] }),
    ).toThrow(/one title column/);
    expect(() => createDatabaseData({ columns: [{ name: 'Name', type: 'text' }] })).toThrow(
      /Duplicate column/,
    );
    expect(() => createDatabaseData({ columns: [{ name: 'X', type: 'nope' as any }] })).toThrow(
      /Unknown column type/,
    );
    expect(() =>
      createDatabaseData({ columns: [{ name: 'N', type: 'number' }], rows: [{ N: 'x' }] }),
    ).toThrow(/not a number/);
    expect(() => createDatabaseData({ rows: [{ Missing: 1 }] })).toThrow(/Unknown column/);
  });

  it('resolves columns by id, name and case-insensitive name', () => {
    const data = createDatabaseData({ columns: [{ name: 'Status', type: 'text' }] });
    const status = data.columns[1];
    expect(resolveColumn(data.columns, status.id)).toBe(status);
    expect(resolveColumn(data.columns, 'Status')).toBe(status);
    expect(resolveColumn(data.columns, 'status')).toBe(status);
    expect(() => resolveColumn(data.columns, 'nope')).toThrow(/Unknown column/);
  });

  it('pages and searches rows', () => {
    const data = createDatabaseData({
      rows: Array.from({ length: 30 }, (_, i) => ({ Name: `row ${i}` })),
    });
    const page = queryRows(data, { offset: 10, limit: 5 });
    expect(page.total).toBe(30);
    expect(page.rows.map((r) => r.values.Name)).toEqual([
      'row 10', 'row 11', 'row 12', 'row 13', 'row 14',
    ]);
    const found = queryRows(data, { search: 'ROW 2' });
    expect(found.matched).toBe(11); // row 2, row 20..29
    expect(found.rows[0].index).toBe(2);
  });
});
