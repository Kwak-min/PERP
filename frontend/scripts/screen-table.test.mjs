import assert from 'node:assert/strict';
import test from 'node:test';
import { liveTable, filterTable, paginateTable, toCsv } from '../src/pages/screenTable.ts';
import { screenFilters, allFilter } from '../src/pages/screenFilters.ts';

const items = Array.from({ length: 25 }, (_, index) => ({ __id: index + 1, name: `record-${index + 1}`, status: index % 2 ? 'draft' : 'active' }));

test('row identity travels with cells through search, status and page transformations', () => {
  const table = liveTable({ items });
  assert.equal(table.rows.length, 25);
  const active = screenFilters['FIN-003'].find(filter => filter.id === 'active');
  const filtered = filterTable(table, { query: 'record-', filter: active });
  assert.deepEqual(filtered.rows.map(row => row.id), items.filter(item => item.status === 'active').map(item => String(item.__id)));
  const page = paginateTable(filtered, 2);
  assert.deepEqual(page.table.rows.map(row => row.id), ['21', '23', '25']);
  assert.equal(page.table.rows[1].cells[0], 'record-23');
  assert.equal(toCsv(filtered).split('\n').length, 14);
});

test('status filtering compares raw status only, not unrelated translated or substring text', () => {
  const table = liveTable({ items: [{ __id: 1, name: '활성 active', status: 'inactive' }, { __id: 2, name: '초안', status: 'active' }] });
  const active = screenFilters['FIN-003'].find(filter => filter.id === 'active');
  assert.deepEqual(filterTable(table, { query: '', filter: active }).rows.map(row => row.id), ['2']);
  assert.deepEqual(filterTable(table, { query: '없는값', filter: allFilter }).rows, []);
});

test('pagination clamps after deletion and preserves empty/export structure', () => {
  const table = liveTable({ items });
  assert.equal(paginateTable(table, 100).currentPage, 3);
  const empty = filterTable(table, { query: 'missing', filter: allFilter });
  assert.equal(paginateTable(empty, 3).currentPage, 1);
  assert.equal(paginateTable(empty, 3).pageCount, 1);
  assert.equal(toCsv(empty).split('\n').length, 1);
});

test('financial metadata stays attached through filtering and pagination but never enters cells or CSV', () => {
  const table = liveTable({ items: items.map(item => ({ __version: item.__id + 10, __metadata: 'internal-only', ...item })) });
  assert.deepEqual(table.columns, ['name', 'status']);
  const active = screenFilters['FIN-003'].find(filter => filter.id === 'active');
  const filtered = filterTable(table, { query: 'record-', filter: active });
  const row = paginateTable(filtered, 2).table.rows[1];
  assert.equal(row.id, '23');
  assert.equal(row.values.__version, 33);
  assert.equal(row.values.__metadata, 'internal-only');
  assert.deepEqual(row.cells, ['record-23', 'active']);
  assert.equal(toCsv(filtered).includes('internal-only'), false);
  assert.equal(filterTable(table, { query: 'internal-only', filter: allFilter }).rows.length, 0);
});

test('legacy IDs stay attached and CSV escapes commas, quotes and line breaks', () => {
  const table = liveTable({ items: [{ id: 'legacy-a', name: 'a,"b"\nc', status: 'active' }] });
  assert.equal(table.rows[0].id, 'legacy-a');
  assert.equal(toCsv(table), 'id,name,status\nlegacy-a,"a,""b""\nc",active');
});
