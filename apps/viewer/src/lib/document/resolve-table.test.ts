/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A table block prints a list the way the list's own export does (#5142):
 * these run `buildExportModel` over real rows — flat, nested groups with
 * sums, the schedule view — and pin what `flattenExportModel` makes of each,
 * including the row cap and the "… n more" / total lines.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ColumnDefinition, ListGrouping, ListRow } from '@ifc-lite/lists';
import { buildExportModel } from '../lists/export/model.js';
import { flattenExportModel, type TableLabels } from './resolve-table.js';

const columns: ColumnDefinition[] = [
  { id: 'name', source: 'attribute', propertyName: 'Name' },
  { id: 'storey', source: 'spatial', propertyName: 'Storey' },
  { id: 'vol', source: 'quantity', psetName: 'Qto', propertyName: 'NetVolume' },
];

const row = (name: string, storey: string, vol: number | null): ListRow => ({ entityId: 0, modelId: 'm', values: [name, storey, vol] });

const rows: ListRow[] = [
  row('W-1', 'Level 1', 1.5), row('W-2', 'Level 1', 2), row('W-3', 'Level 2', 0.25), row('W-4', 'Level 2', null), row('D-1', 'Level 2', 3),
];

const labels: TableLabels = { more: (n) => `+${n}`, total: (c) => `T${c}` };

function model(grouping?: ListGrouping, subset = rows) {
  return buildExportModel({ title: 'Walls', columns, rows: subset, grouping, numericCols: [false, false, true], columnWidths: [], generatedAt: 'now' });
}

describe('flattenExportModel (#5142)', () => {
  it('prints flat rows with formatted cells and no totals line when nothing is summed', () => {
    const t = flattenExportModel(model(), 50, labels);
    assert.deepEqual(t.columns, [{ label: 'Name', numeric: false }, { label: 'Storey', numeric: false }, { label: 'NetVolume', numeric: true }]);
    assert.deepEqual(t.rows.map((r) => r.role), ['row', 'row', 'row', 'row', 'row']);
    assert.deepEqual(t.rows[3].cells, ['W-4', 'Level 2', '']);
    assert.deepEqual(t.rows[2].cells, ['W-3', 'Level 2', '0.25']);
    assert.equal(t.more, 0);
    assert.equal(t.totalRows, 5);
  });

  it('caps data rows, says how many more there are, and still prints the grand total of ALL rows', () => {
    const t = flattenExportModel(model({ columnId: '', sumColumnIds: ['vol'] }), 2, labels);
    assert.deepEqual(t.rows.map((r) => r.role), ['row', 'row', 'more', 'total']);
    assert.deepEqual(t.rows[2].cells, ['+3', '', '']);
    assert.deepEqual(t.rows[3].cells, ['T5', '', '6.75']);
    assert.equal(t.more, 3);
  });

  it('prints group headers with count and sums in the export order (largest group first), leaf rows under them, headers not counting against the cap', () => {
    const t = flattenExportModel(model({ columnId: 'storey', columnIds: ['storey'], sumColumnIds: ['vol'] }), 4, labels);
    assert.deepEqual(t.rows.map((r) => r.role), ['group', 'row', 'row', 'row', 'group', 'row', 'more', 'total']);
    assert.deepEqual(t.rows[0].cells, ['Level 2  (3)', '', '3.25']);
    assert.deepEqual(t.rows[4].cells, ['Level 1  (2)', '', '3.5']);
    assert.deepEqual(t.rows[5].cells, ['W-1', 'Level 1', '1.5']);
    assert.equal(t.more, 1);
  });

  it('prints the schedule view as one row per group tuple with Count, and the total row counts elements', () => {
    const t = flattenExportModel(model({ columnId: 'storey', columnIds: ['storey'], sumColumnIds: ['vol'], view: 'schedule' }), 50, labels);
    assert.deepEqual(t.columns.map((c) => c.label), ['Storey', 'Count', 'NetVolume']);
    assert.deepEqual(t.rows.map((r) => r.cells), [['Level 2', '3', '3.25'], ['Level 1', '2', '3.5'], ['T5', '5', '6.75']]);
    assert.equal(t.totalRows, 2);
  });

  it('a cap below one row still prints one row rather than none', () => {
    const t = flattenExportModel(model(), 0, labels);
    assert.deepEqual(t.rows.map((r) => r.role), ['row', 'more']);
  });
});
