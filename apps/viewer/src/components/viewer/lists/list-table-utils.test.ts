/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { groupPathKey, type ColumnDefinition, type ListRow } from '@ifc-lite/lists';
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

// Multi-criteria grouping (issue #1790): e.g. group by Building, then Storey.
describe('buildGroupedView multi-criteria grouping (#1790)', () => {
  const cols: ColumnDefinition[] = [
    { id: 'building', source: 'spatial', propertyName: 'Building' },
    { id: 'storey', source: 'spatial', propertyName: 'Storey' },
    { id: 'qty', source: 'quantity', propertyName: 'Qty' },
  ];
  const mkRows = (...tuples: [string, string, number][]): ListRow[] =>
    tuples.map(([b, s, q], i) => ({ entityId: i + 1, modelId: 'm', values: [b, s, q] }));
  // Building A: 3 rows over 2 storeys; Building B: 1 row.
  const sample = mkRows(['A', 'L0', 1], ['A', 'L0', 2], ['A', 'L1', 3], ['B', 'L0', 4]);
  const grouping = { columnId: 'building', columnIds: ['building', 'storey'], sumColumnIds: ['qty'] };
  const keyA = groupPathKey(['A']);
  const keyB = groupPathKey(['B']);
  const keyAL0 = groupPathKey(['A', 'L0']);

  it('collapsed: shows only top-level headers, but groupKeys covers every level', () => {
    const view = buildGroupedView(sample, cols, grouping, new Set(), null);
    assert.deepStrictEqual(
      view.items.map((i) => (i.kind === 'group' ? [i.level, i.label, i.count] : 'row')),
      [[0, 'A', 3], [0, 'B', 1]],
    );
    assert.strictEqual(view.groupCount, 2);
    assert.deepStrictEqual(view.groupKeys, [keyA, keyAL0, groupPathKey(['A', 'L1']), keyB, groupPathKey(['B', 'L0'])]);
  });

  it('expanding a parent reveals its sub-groups with per-group counts, not rows', () => {
    const view = buildGroupedView(sample, cols, grouping, new Set([keyA]), null);
    assert.deepStrictEqual(
      view.items.map((i) => (i.kind === 'group' ? [i.level, i.label, i.count] : 'row')),
      [[0, 'A', 3], [1, 'L0', 2], [1, 'L1', 1], [0, 'B', 1]],
    );
  });

  it('expanding a leaf sub-group reveals its member rows in place', () => {
    const view = buildGroupedView(sample, cols, grouping, new Set([keyA, keyAL0]), null);
    assert.deepStrictEqual(
      view.items.map((i) => (i.kind === 'group' ? `${i.level}:${i.label}` : `row:${(i as { row: ListRow }).row.entityId}`)),
      ['0:A', '1:L0', 'row:1', 'row:2', '1:L1', '0:B'],
    );
  });

  it('a collapsed parent hides expanded children (no orphaned sub-headers)', () => {
    const view = buildGroupedView(sample, cols, grouping, new Set([keyAL0]), null);
    assert.deepStrictEqual(
      view.items.map((i) => (i.kind === 'group' ? i.label : 'row')),
      ['A', 'B'],
    );
  });

  it('sums subtotal at every level and grand totals are not double-counted', () => {
    const view = buildGroupedView(sample, cols, grouping, new Set([keyA]), null);
    const byLabel = new Map(view.items.filter((i) => i.kind === 'group').map((g) => [`${(g as { level: number }).level}:${(g as { label: string }).label}`, (g as { sums: Record<string, number> }).sums.qty]));
    assert.strictEqual(byLabel.get('0:A'), 6);
    assert.strictEqual(byLabel.get('1:L0'), 3);
    assert.strictEqual(byLabel.get('1:L1'), 3);
    assert.strictEqual(view.totals.sums.qty, 10);
    assert.strictEqual(view.totals.count, 4);
  });

  it('the same sub-label under two parents stays two distinct groups', () => {
    const view = buildGroupedView(sample, cols, grouping, new Set([keyA, keyB]), null);
    const l0Groups = view.items.filter((i) => i.kind === 'group' && (i as { label: string }).label === 'L0');
    assert.strictEqual(l0Groups.length, 2);
    const keys = l0Groups.map((g) => (g as { key: string }).key);
    assert.deepStrictEqual(keys, [keyAL0, groupPathKey(['B', 'L0'])]);
  });

  it('labels containing separator-like characters cannot collide (JSON path keys)', () => {
    // Crafted so a naive join would collide: "X/Y"+"Z" vs "X"+"Y/Z".
    const tricky = mkRows(['X/Y', 'Z', 1], ['X', 'Y/Z', 2]);
    const view = buildGroupedView(tricky, cols, grouping, new Set(), null);
    assert.strictEqual(new Set(view.groupKeys).size, view.groupKeys.length);
  });

  it('an empty row set yields no groups and zero totals', () => {
    const view = buildGroupedView([], cols, grouping, new Set(), null);
    assert.deepStrictEqual(view.items, []);
    assert.strictEqual(view.groupCount, 0);
    assert.deepStrictEqual(view.groupKeys, []);
    assert.strictEqual(view.totals.count, 0);
    assert.strictEqual(view.totals.sums.qty, 0);
  });

  it('legacy single-columnId grouping is unchanged (level 0 only)', () => {
    const view = buildGroupedView(sample, cols, { columnId: 'building', sumColumnIds: [] }, new Set([keyA]), null);
    assert.deepStrictEqual(
      view.items.map((i) => (i.kind === 'group' ? [i.level, i.label, i.count] : 'row')),
      [[0, 'A', 3], 'row', 'row', 'row', [0, 'B', 1]],
    );
  });
});

describe('compareCells', () => {
  it('orders numbers numerically and nulls first', () => {
    assert.ok(compareCells(2, 10) < 0);
    assert.ok(compareCells(null, 0) < 0);
    assert.strictEqual(compareCells(null, null), 0);
  });
});
