import { CellInput, DatabaseSpec } from '@docmost/editor-ext';

/**
 * A database shaped like AFFiNE's *Target List* (777 rows x 8 columns, one
 * of every column type). Used by tests and by the dev seed script.
 */
export const TARGET_LIST_COLUMNS: DatabaseSpec['columns'] = [
  { name: 'Organisation', type: 'title' },
  { name: 'Notes', type: 'text' },
  { name: 'Staff', type: 'number' },
  { name: 'Status', type: 'select', options: ['To contact', 'Contacted', 'Partner'] },
  { name: 'Sectors', type: 'multi-select', options: ['Health', 'Education', 'Logistics'] },
  { name: 'Next step', type: 'date' },
  { name: 'Priority', type: 'checkbox' },
  { name: 'Website', type: 'link' },
];

const STATUSES = ['To contact', 'Contacted', 'Partner'];
const SECTORS = ['Health', 'Education', 'Logistics', 'Water', 'Shelter'];

export function targetListRow(i: number): Record<string, CellInput> {
  const day = String((i % 28) + 1).padStart(2, '0');
  const month = String((i % 12) + 1).padStart(2, '0');
  return {
    Organisation: `Organisation ${i + 1}`,
    Notes: i % 5 === 0 ? `Met at event #${i}; follow up | pipe` : null,
    Staff: i % 7 === 0 ? null : (i * 37) % 1200,
    Status: STATUSES[i % STATUSES.length],
    Sectors: [SECTORS[i % SECTORS.length], SECTORS[(i * 3 + 1) % SECTORS.length]],
    'Next step': i % 4 === 0 ? null : `2027-${month}-${day}`,
    Priority: i % 3 === 0,
    Website: i % 2 === 0 ? `https://org${i + 1}.example.org` : null,
  };
}

export function targetListSpec(rows = 777): DatabaseSpec {
  return {
    title: 'Target List',
    columns: TARGET_LIST_COLUMNS,
    rows: Array.from({ length: rows }, (_, i) => targetListRow(i)),
  };
}
