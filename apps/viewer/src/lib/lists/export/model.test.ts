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
