/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { ColumnDefinition, ListRow } from '@ifc-lite/lists';
import { buildGroupedView, compareCells, type GroupSort } from './list-table-utils';

const columns: ColumnDefinition[] = [
  { id: 'cat', source: 'attribute', propertyName: 'Category' },
  { id: 'qty', source: 'quantity', propertyName: 'Qty' },
];

/** Build a row list from [category, qty] tuples. */
function rows(...tuples: [string, number][]): ListRow[] {
  return tuples.map(([cat, qty], i) => ({ entityId: i + 1, modelId: 'm', values: [cat, qty] }));
}

/** The visible group labels, in order, from a grouped view. */
function groupOrder(view: { items: { kind: string }[] }): string[] {
  return view.items
    .filter((i): i is { kind: 'group'; label: string } => i.kind === 'group')
    .map((g) => g.label);
}

const GROUP_BY_CAT = { columnId: 'cat', sumColumnIds: ['qty'] };
const NO_EXPAND = new Set<string>();

describe('buildGroupedView group ordering (#1498)', () => {
  // Three categories whose group sizes deliberately disagree with their
  // alphabetical order, so a count-sort and a value-sort are distinguishable.
  //   C: 3 rows, A: 2 rows, B: 1 row
  const sample = rows(
    ['C', 10], ['C', 20], ['C', 5],
    ['A', 7], ['A', 3],
    ['B', 100],
  );

  it('defaults to count-descending when no sort is active', () => {
    const view = buildGroupedView(sample, columns, GROUP_BY_CAT, NO_EXPAND, null);
    assert.deepStrictEqual(groupOrder(view), ['C', 'A', 'B']);
  });

  it('sorting ascending on the group column orders groups by value, not count', () => {
    const sort: GroupSort = { colIdx: 0, dir: 'asc' };
    const view = buildGroupedView(sample, columns, GROUP_BY_CAT, NO_EXPAND, sort);
    assert.deepStrictEqual(groupOrder(view), ['A', 'B', 'C']);
  });

  it('sorting descending on the group column reverses the group order', () => {
    const sort: GroupSort = { colIdx: 0, dir: 'desc' };
    const view = buildGroupedView(sample, columns, GROUP_BY_CAT, NO_EXPAND, sort);
    assert.deepStrictEqual(groupOrder(view), ['C', 'B', 'A']);
  });

  it('asc and desc on the group column produce different orders (the reported bug)', () => {
    const asc = groupOrder(buildGroupedView(sample, columns, GROUP_BY_CAT, NO_EXPAND, { colIdx: 0, dir: 'asc' }));
    const desc = groupOrder(buildGroupedView(sample, columns, GROUP_BY_CAT, NO_EXPAND, { colIdx: 0, dir: 'desc' }));
    assert.notDeepStrictEqual(asc, desc);
    assert.deepStrictEqual(asc, [...desc].reverse());
  });

  it('sorting on a summed column orders groups by their aggregate sum', () => {
    // Sums: C=35, A=10, B=100.
    const asc = buildGroupedView(sample, columns, GROUP_BY_CAT, NO_EXPAND, { colIdx: 1, dir: 'asc' });
    assert.deepStrictEqual(groupOrder(asc), ['A', 'C', 'B']);
    const desc = buildGroupedView(sample, columns, GROUP_BY_CAT, NO_EXPAND, { colIdx: 1, dir: 'desc' });
    assert.deepStrictEqual(groupOrder(desc), ['B', 'C', 'A']);
  });

  it('breaks summed-column ties in the sort direction', () => {
    // Sums: X=5, Y=5 (tie), Z=9 — ties resolve by label following the arrow.
    const tie = rows(['X', 5], ['Y', 5], ['Z', 9]);
    const asc = groupOrder(buildGroupedView(tie, columns, GROUP_BY_CAT, NO_EXPAND, { colIdx: 1, dir: 'asc' }));
    assert.deepStrictEqual(asc, ['X', 'Y', 'Z']);
    const desc = groupOrder(buildGroupedView(tie, columns, GROUP_BY_CAT, NO_EXPAND, { colIdx: 1, dir: 'desc' }));
    assert.deepStrictEqual(desc, ['Z', 'Y', 'X']);
  });

  it('numeric group columns sort numerically, not lexically', () => {
    const numCols: ColumnDefinition[] = [{ id: 'n', source: 'attribute', propertyName: 'N' }];
    const numRows: ListRow[] = [2, 10, 1].map((n, i) => ({ entityId: i + 1, modelId: 'm', values: [n] }));
    const view = buildGroupedView(numRows, numCols, { columnId: 'n', sumColumnIds: [] }, NO_EXPAND, { colIdx: 0, dir: 'asc' });
    assert.deepStrictEqual(groupOrder(view), ['1', '2', '10']);
  });

  it('empty group values sort first ascending under a single (none) bucket', () => {
    const withBlank = rows(['B', 1], ['A', 1]);
    withBlank.push({ entityId: 99, modelId: 'm', values: ['', 1] });
    const view = buildGroupedView(withBlank, columns, GROUP_BY_CAT, NO_EXPAND, { colIdx: 0, dir: 'asc' });
    assert.deepStrictEqual(groupOrder(view), ['(none)', 'A', 'B']);
  });

  it('falls back to count-descending for a sort on a non-group, non-summed column', () => {
    // colIdx 1 is not summed here, so groups keep the default order.
    const noSum = { columnId: 'cat', sumColumnIds: [] };
    const view = buildGroupedView(sample, columns, noSum, NO_EXPAND, { colIdx: 1, dir: 'asc' });
    assert.deepStrictEqual(groupOrder(view), ['C', 'A', 'B']);
  });
});

describe('compareCells', () => {
  it('orders numbers numerically and nulls first', () => {
    assert.ok(compareCells(2, 10) < 0);
    assert.ok(compareCells(null, 0) < 0);
    assert.strictEqual(compareCells(null, null), 0);
  });
});
