/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { ColumnDefinition, ListRow } from '@ifc-lite/lists';
import { ProjectUnits } from '@ifc-lite/parser';
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

// Multi-criteria grouping in exports (issue #1790): nested sections in
// pre-order, per-group counts at every level, member rows on leaves only.
describe('buildExportModel multi-criteria grouping (#1790)', () => {
  const cols3: ColumnDefinition[] = [
    { id: 'building', source: 'spatial', propertyName: 'Building' },
    { id: 'storey', source: 'spatial', propertyName: 'Storey' },
    { id: 'qty', source: 'quantity', propertyName: 'Qty' },
  ];
  const rows3: ListRow[] = ([
    ['A', 'L0', 1], ['A', 'L0', 2], ['A', 'L1', 3], ['B', 'L0', 4],
  ] as [string, string, number][]).map(([b, s, q], i) => ({ entityId: i + 1, modelId: 'm', values: [b, s, q] }));
  const input = {
    title: 'List',
    columns: cols3,
    rows: rows3,
    numericCols: [false, false, true],
    columnWidths: [120, 120, 120],
    generatedAt: 'now',
    grouping: { columnId: 'building', columnIds: ['building', 'storey'], sumColumnIds: ['qty'] },
  };

  it('emits pre-order nested groups with level, path and per-group count', () => {
    const m = buildExportModel({ ...input });
    assert.deepStrictEqual(
      m.groups?.map((g) => [g.level, g.label, g.count, g.rows.length]),
      [
        [0, 'A', 3, 0],
        [1, 'L0', 2, 2],
        [1, 'L1', 1, 1],
        [0, 'B', 1, 0],
        [1, 'L0', 1, 1],
      ],
    );
    assert.deepStrictEqual(m.groups?.[1].path, ['A', 'L0']);
    assert.deepStrictEqual(m.groupColumnIds, ['building', 'storey']);
    assert.strictEqual(m.groupColumnId, 'building');
    // Subtotals at both levels; grand totals not double-counted.
    assert.strictEqual(m.groups?.[0].sums.qty, 6);
    assert.strictEqual(m.groups?.[1].sums.qty, 3);
    assert.strictEqual(m.totals.sums.qty, 10);
    assert.strictEqual(m.totals.count, 4);
  });

  it('single-level grouping keeps rows on every group (all groups are leaves)', () => {
    const m = buildExportModel({ ...input, grouping: { columnId: 'building', sumColumnIds: [] } });
    assert.deepStrictEqual(m.groups?.map((g) => [g.level, g.label, g.rows.length]), [[0, 'A', 3], [0, 'B', 1]]);
    assert.deepStrictEqual(m.groupColumnIds, ['building']);
  });
});

// #1573: quantity/measure columns export converted into the user's
// display-unit override, with the resolved symbol folded into the header.
describe('buildExportModel display-unit conversion (#1573)', () => {
  const volumeColumns: ColumnDefinition[] = [
    { id: 'cat', source: 'attribute', propertyName: 'Category' },
    { id: 'qty', source: 'quantity', psetName: 'Qto', propertyName: 'Volume', quantityType: 2 /* Volume */ },
  ];

  function volumeRows(...tuples: [string, number | null][]): ListRow[] {
    return tuples.map(([cat, qty], i) => ({ entityId: i + 1, modelId: 'm', values: [cat, qty] }));
  }

  it('converts quantity values into the overridden unit and folds the symbol into the label', () => {
    const rowsIn = volumeRows(['A', 1], ['B', 2]);
    const m = buildExportModel({
      title: 'List',
      columns: volumeColumns,
      rows: rowsIn,
      numericCols: [false, true],
      columnWidths: [120, 120],
      generatedAt: 'now',
      modelUnits: new Map([['m', ProjectUnits.empty()]]),
      unitDisplayOverrides: { VOLUMEUNIT: 'l' }, // 1 m³ = 1000 L
    });

    assert.strictEqual(m.columns[1].unit, 'L');
    assert.match(m.columns[1].label, /\(L\)$/);
    assert.deepStrictEqual(m.rows, [['A', 1000], ['B', 2000]]);
    // The original ListRow values passed in are never mutated — export is
    // display-only, and these arrays are shared with the live on-screen table.
    assert.deepStrictEqual(rowsIn[0].values, ['A', 1]);
    assert.deepStrictEqual(rowsIn[1].values, ['B', 2]);
  });

  it('still labels the column (SI default) but leaves values raw when there is no override', () => {
    const m = buildExportModel({
      title: 'List',
      columns: volumeColumns,
      rows: volumeRows(['A', 1]),
      numericCols: [false, true],
      columnWidths: [120, 120],
      generatedAt: 'now',
      modelUnits: new Map([['m', ProjectUnits.empty()]]),
      unitDisplayOverrides: {},
    });

    assert.strictEqual(m.columns[1].unit, 'm³');
    assert.deepStrictEqual(m.rows, [['A', 1]]);
  });

  it('converts every row (not just the first) — no more "seed row" needed since the target unit is resolved ahead of the rows', () => {
    const m = buildExportModel({
      title: 'List',
      columns: volumeColumns,
      rows: volumeRows(['A', null], ['B', 3]),
      numericCols: [false, true],
      columnWidths: [120, 120],
      generatedAt: 'now',
      modelUnits: new Map([['m', ProjectUnits.empty()]]),
      unitDisplayOverrides: { VOLUMEUNIT: 'l' },
    });

    assert.strictEqual(m.columns[1].unit, 'L');
    assert.deepStrictEqual(m.rows, [['A', null], ['B', 3000]]);
  });

  it('converts a measure property column via its dataType', () => {
    const columns: ColumnDefinition[] = [
      { id: 'flow', source: 'property', psetName: 'Pset', propertyName: 'Flow', dataType: 'IFCVOLUMETRICFLOWRATEMEASURE' },
    ];
    const m = buildExportModel({
      title: 'List',
      columns,
      rows: [{ entityId: 1, modelId: 'm', values: [0.013888888888888888] }],
      numericCols: [true],
      columnWidths: [120],
      generatedAt: 'now',
      modelUnits: new Map([['m', ProjectUnits.empty()]]),
      unitDisplayOverrides: { VOLUMETRICFLOWRATEUNIT: 'm3h' },
    });

    assert.strictEqual(m.columns[0].unit, 'm³/h');
    const converted = m.rows[0][0];
    assert.strictEqual(typeof converted, 'number');
    assert.ok(Math.abs((converted as number) - 50) < 1e-6);
  });

  it('leaves values and labels untouched when modelUnits/overrides are omitted (legacy callers)', () => {
    const m = buildExportModel({
      title: 'List',
      columns: volumeColumns,
      rows: volumeRows(['A', 1]),
      numericCols: [false, true],
      columnWidths: [120, 120],
      generatedAt: 'now',
    });

    assert.strictEqual(m.columns[1].unit, undefined);
    assert.strictEqual(m.columns[1].label, 'Volume');
    assert.deepStrictEqual(m.rows, [['A', 1]]);
  });

  it('federated: a 2-entry modelUnits map converts each row from ITS OWN model (mm vs m declared length)', () => {
    const mmModel = new Map([['LENGTHUNIT', { symbol: 'mm', siScale: 1e-3 }]]);
    const mModel = new Map([['LENGTHUNIT', { symbol: 'm', siScale: 1 }]]);
    const columns: ColumnDefinition[] = [
      { id: 'len', source: 'quantity', psetName: 'Qto', propertyName: 'Length', quantityType: 0 /* Length */ },
    ];
    const m = buildExportModel({
      title: 'List',
      columns,
      rows: [
        { entityId: 1, modelId: 'mmModel', values: [1000] },
        { entityId: 2, modelId: 'mModel', values: [1] },
      ],
      numericCols: [true],
      columnWidths: [120],
      generatedAt: 'now',
      modelUnits: new Map([
        ['mmModel', new ProjectUnits(mmModel, null)],
        ['mModel', new ProjectUnits(mModel, null)],
      ]),
      unitDisplayOverrides: { LENGTHUNIT: 'm' },
    });

    assert.strictEqual(m.columns[0].unit, 'm');
    assert.deepStrictEqual(m.rows, [[1], [1]]); // 1000mm -> 1m, and 1m -> 1m
  });
});
