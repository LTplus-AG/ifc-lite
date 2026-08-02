/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { ColumnDefinition, ListRow } from '@ifc-lite/lists';
import { buildExportModel } from './model';
import { toCsv } from './csv';

const cols3: ColumnDefinition[] = [
  { id: 'building', source: 'spatial', propertyName: 'Building' },
  { id: 'storey', source: 'spatial', propertyName: 'Storey' },
  { id: 'type', source: 'attribute', propertyName: 'Class' },
  { id: 'area', source: 'quantity', propertyName: 'Area' },
];
const rows3: ListRow[] = ([
  ['P01', 'Level 0', 'IfcWall', 10],
  ['P01', 'Level 0', 'IfcWall', 12],
  ['P01', 'Level 1', 'IfcDoor', 4],
  ['P02', 'Level 0', 'IfcWall', 8],
] as [string, string, string, number][]).map(([b, s, t, a], i) => ({ entityId: i + 1, modelId: 'm', values: [b, s, t, a] }));

// Bonsai's own CSV mirrors its schedule table (Building | Storey | Type |
// Count | Area), not a per-element flat table — this is the exact arrangement
// steverugi asked for in issue #1790's round-2 comment.
describe('toCsv schedule (pivot) arrangement (#1790 round 2)', () => {
  const base = {
    title: 'Schedule',
    columns: cols3,
    rows: rows3,
    numericCols: [false, false, false, true],
    columnWidths: [120, 120, 120, 120],
    generatedAt: 'now',
  };

  it('one row per group-value tuple: group columns, Count, then sums — full values, never blanked', () => {
    const model = buildExportModel({
      ...base,
      grouping: { columnId: 'building', columnIds: ['building', 'storey', 'type'], sumColumnIds: ['area'], view: 'schedule' },
    });
    const csv = toCsv(model);
    const lines = csv.split('\r\n');
    assert.strictEqual(lines[0], 'Building,Storey,Class,Count,Area');
    assert.deepStrictEqual(lines.slice(1, 4), [
      'P01,Level 0,IfcWall,2,22',
      'P01,Level 1,IfcDoor,1,4',
      'P02,Level 0,IfcWall,1,8',
    ]);
    // Grand total row.
    assert.strictEqual(lines[4], 'TOTAL (4),,,4,34');
  });

  it('the flat per-element CSV (no schedule view) still exports the old Group-path arrangement unchanged', () => {
    const model = buildExportModel({
      ...base,
      grouping: { columnId: 'building', columnIds: ['building', 'storey'], sumColumnIds: ['area'] },
    });
    const csv = toCsv(model);
    const lines = csv.split('\r\n');
    assert.strictEqual(lines[0], 'Group,Building,Storey,Class,Area');
    // One CSV row PER ELEMENT (4 elements), grouped rows carry the full path.
    assert.strictEqual(lines.length, 1 + rows3.length + 1); // header + 4 rows + TOTAL
    assert.ok(lines[1].startsWith('P01 / Level 0,'));
  });

  it('single-criterion schedule: every top-level group is a leaf row', () => {
    const model = buildExportModel({
      ...base,
      grouping: { columnId: 'building', sumColumnIds: ['area'], view: 'schedule' },
    });
    const csv = toCsv(model);
    assert.deepStrictEqual(csv.split('\r\n'), [
      'Building,Count,Area',
      'P01,3,26',
      'P02,1,8',
      'TOTAL (4),4,34',
    ]);
  });

  it('schedule view without sums still emits a Count-only pivot', () => {
    const model = buildExportModel({
      ...base,
      grouping: { columnId: 'building', columnIds: ['building', 'storey'], sumColumnIds: [], view: 'schedule' },
    });
    const csv = toCsv(model);
    assert.strictEqual(csv.split('\r\n')[0], 'Building,Storey,Count');
    // No sum columns configured -> no TOTAL row (matches the flat-view behaviour).
    assert.strictEqual(csv.split('\r\n').length, 1 + 3);
  });
});
