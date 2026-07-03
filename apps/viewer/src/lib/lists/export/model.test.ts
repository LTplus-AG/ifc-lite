/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { ColumnDefinition, ListRow } from '@ifc-lite/lists';
import { buildExportModel } from './model';

const columns: ColumnDefinition[] = [
  { id: 'cat', source: 'attribute', propertyName: 'Category' },
  { id: 'qty', source: 'quantity', propertyName: 'Qty' },
];

function rows(...tuples: [string, number][]): ListRow[] {
  return tuples.map(([cat, qty], i) => ({ entityId: i + 1, modelId: 'm', values: [cat, qty] }));
}

// C: 3 rows, A: 2 rows, B: 1 row — count order disagrees with value order.
const sample = rows(['C', 10], ['C', 20], ['C', 5], ['A', 7], ['A', 3], ['B', 100]);
const base = {
  title: 'List',
  columns,
  numericCols: [false, true],
  columnWidths: [120, 120],
  generatedAt: 'now',
  grouping: { columnId: 'cat', sumColumnIds: ['qty'] },
};

describe('buildExportModel grouped-section order honours the on-screen sort (#1498)', () => {
  it('defaults to count-descending with no sort', () => {
    const m = buildExportModel({ ...base, rows: sample });
    assert.deepStrictEqual(m.groups?.map((g) => g.label), ['C', 'A', 'B']);
  });

  it('follows an ascending group-column sort', () => {
    const m = buildExportModel({ ...base, rows: sample, sort: { colIdx: 0, dir: 'asc' } });
    assert.deepStrictEqual(m.groups?.map((g) => g.label), ['A', 'B', 'C']);
  });

  it('follows a descending group-column sort', () => {
    const m = buildExportModel({ ...base, rows: sample, sort: { colIdx: 0, dir: 'desc' } });
    assert.deepStrictEqual(m.groups?.map((g) => g.label), ['C', 'B', 'A']);
  });

  it('follows a summed-column sort by aggregate', () => {
    // Sums: A=10, C=35, B=100.
    const m = buildExportModel({ ...base, rows: sample, sort: { colIdx: 1, dir: 'asc' } });
    assert.deepStrictEqual(m.groups?.map((g) => g.label), ['A', 'C', 'B']);
  });
});
