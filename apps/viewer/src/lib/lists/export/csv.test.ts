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

// CSV is machine-readable output. Every assertion here is on the CSV TEXT
// produced by the real `buildExportModel` -> `toCsv` path, because the defects
// it pins were both invisible to a unit test of the escaper: the escaper was
// correct and `displayCell` was correct, and routing one through the other is
// what produced a number a spreadsheet could not read back.
describe('toCsv numeric columns round-trip as numbers', () => {
  const numCols: ColumnDefinition[] = [
    { id: 'building', source: 'spatial', propertyName: 'Building' },
    { id: 'type', source: 'attribute', propertyName: 'Class' },
    { id: 'area', source: 'quantity', propertyName: 'Area' },
  ];
  // Every value is chosen to EXCEED the thing being tested, not to sit on it:
  // |x| >= 1000 so a display formatter inserts a grouping separator, and the
  // sign so the formula guard has a trigger to fire on.
  const numRows: ListRow[] = ([
    ['P01', 'IfcWall', -3000],
    ['P01', 'IfcWall', -0.35],
    ['P02', 'IfcDoor', 1234567],
    ['P02', 'IfcDoor', 0.35],
  ] as [string, string, number][]).map(([b, t, a], i) => ({
    entityId: i + 1, modelId: 'm', values: [b, t, a],
  }));
  const numBase = {
    title: 'Numbers',
    columns: numCols,
    rows: numRows,
    numericCols: [false, false, true],
    columnWidths: [120, 120, 120],
    generatedAt: 'now',
  };

  it('emits the raw number, never the display-formatted one', () => {
    const csv = toCsv(buildExportModel({ ...numBase, grouping: { columnId: '', sumColumnIds: ['area'] } }));
    assert.deepStrictEqual(csv.split('\r\n'), [
      'Building,Class,Area',
      'P01,IfcWall,-3000',
      'P01,IfcWall,-0.35',
      'P02,IfcDoor,1234567',
      'P02,IfcDoor,0.35',
      'TOTAL (4),,1231567',
    ]);
  });

  it('no numeric cell is quoted or apostrophe-prefixed', () => {
    // The two failure modes, stated as the damage rather than the mechanism: a
    // quoted cell stops the column summing, an apostrophe makes it text. Under
    // a `.`-grouping locale the old path emitted neither -- it emitted a BARE
    // `-3.000`, which a `,`-grouping spreadsheet reads back as -3.
    const csv = toCsv(buildExportModel({ ...numBase, grouping: { columnId: '', sumColumnIds: ['area'] } }));
    for (const line of csv.split('\r\n').slice(1)) {
      const areaCell = line.split(',').at(-1) ?? '';
      assert.ok(!areaCell.includes('"'), `area cell was quoted: ${areaCell}`);
      assert.ok(!areaCell.startsWith("'"), `area cell was prefixed: ${areaCell}`);
      assert.strictEqual(areaCell, String(Number(areaCell)), `area cell is not a bare number: ${areaCell}`);
    }
  });

  it('a real number in a MIXED column is still summable', () => {
    // `detectNumericColumns` marks a whole column as text if one sampled value
    // is a string, which mixed IFC properties routinely are. Keying the
    // exemption off the COLUMN re-created #1772 here: every genuine number in
    // the column, and the grand total with them, shipped as `'-3.35` text.
    const rows: ListRow[] = [
      { entityId: 1, modelId: 'm', values: ['P01', 'W1', -3] },
      { entityId: 2, modelId: 'm', values: ['P01', 'W2', 'n/a'] },
      { entityId: 3, modelId: 'm', values: ['P01', 'W3', -0.35] },
      { entityId: 4, modelId: 'm', values: ['P01', 'W4', '+41791234567'] },
    ];
    const csv = toCsv(buildExportModel({
      ...numBase, rows,
      numericCols: [false, false, false], // the mixed column reads as text
      grouping: { columnId: '', sumColumnIds: ['area'] },
    }));
    const lines = csv.split('\r\n');
    assert.strictEqual(lines[1], 'P01,W1,-3');
    assert.strictEqual(lines[3], 'P01,W3,-0.35');
    // A string that merely looks numeric is still text.
    assert.strictEqual(lines[4], "P01,W4,'+41791234567");
    // The grand total is the assertion that matters: text here breaks SUM().
    assert.strictEqual(lines[5], 'TOTAL (4),,-3.35');
  });

  it('a numeric-looking STRING cell stays text', () => {
    // The exemption is type-aware here: this writer knows the column is not
    // numeric, so `-1` is an identifier, not a measure. A phone number
    // (`+41791234567`) is the case that matters -- exempting it would let a
    // spreadsheet render 4.1791E+10 and drop the `+`.
    const rows: ListRow[] = [
      { entityId: 1, modelId: 'm', values: ['P01', '-1', 1] },
      { entityId: 2, modelId: 'm', values: ['P01', '+41791234567', 2] },
      { entityId: 3, modelId: 'm', values: ['P01', '=cmd()', 3] },
    ];
    const csv = toCsv(buildExportModel({ ...numBase, rows, grouping: { columnId: '', sumColumnIds: [] } }));
    const lines = csv.split('\r\n');
    assert.strictEqual(lines[1], "P01,'-1,1");
    assert.strictEqual(lines[2], "P01,'+41791234567,2");
    assert.strictEqual(lines[3], "P01,'=cmd(),3");
  });
});

// GROUPED exports, which every test above was blind to: they all built an
// ungrouped model, so `c.numeric` reached the writer intact. Grouping routes
// the value through `buildNestedGroupBuckets`, which formats labels with
// `displayCell` on the way in, and the schedule presentation used to hard-code
// `numeric: false` on its grouping columns on the way out.
describe('toCsv keeps a numeric GROUPING column numeric', () => {
  const cols: ColumnDefinition[] = [
    { id: 'lvl', source: 'spatial', propertyName: 'Level' },
    { id: 'area', source: 'quantity', propertyName: 'Area' },
  ];
  // -3000 exceeds the grouping-separator threshold in both directions: en-US
  // renders it "-3,000" (quoted, so the column stops summing) and de-DE renders
  // it "-3.000" (bare, so an en-US reader gets -3). Neither is the number.
  const rows: ListRow[] = [
    { entityId: 1, modelId: 'm', values: [-3000, 1] },
    { entityId: 2, modelId: 'm', values: [-3000, 2] },
  ];
  const base = {
    title: 'T', columns: cols, rows, numericCols: [true, true],
    columnWidths: [90, 90], generatedAt: 'now',
  };

  it('the schedule pivot writes the group value as a number', () => {
    // This is the ONLY place the grouping value appears in this presentation,
    // so getting it wrong loses the value rather than merely duplicating it.
    const csv = toCsv(buildExportModel({
      ...base,
      grouping: { columnId: 'lvl', columnIds: ['lvl'], sumColumnIds: ['area'], view: 'schedule' },
    }));
    assert.deepStrictEqual(csv.split('\r\n'), ['Level,Count,Area', '-3000,2,3', 'TOTAL (2),2,3']);
  });

  it('a TEXT grouping column carrying a formula is still guarded', () => {
    // The control: inheriting `numeric` from the source column must not hand a
    // payload through as if it were data.
    const csv = toCsv(buildExportModel({
      title: 'T', columns: cols,
      rows: [{ entityId: 1, modelId: 'm', values: ['=cmd()', 1] }],
      numericCols: [false, true], columnWidths: [90, 90], generatedAt: 'now',
      grouping: { columnId: 'lvl', columnIds: ['lvl'], sumColumnIds: ['area'], view: 'schedule' },
    }));
    assert.strictEqual(csv.split('\r\n')[1], "'=cmd(),1,1");
  });

  it('falls back to the label when one bucket holds DIFFERENT raw values', () => {
    // Buckets are keyed by the formatted label, so 12.345671 and 12.345679 --
    // distinct numbers that both render "12.3457" -- are one group. Emitting
    // either raw value would put a number in the file that only half the
    // members have.
    const csv = toCsv(buildExportModel({
      ...base,
      rows: [
        { entityId: 1, modelId: 'm', values: [12.345671, 1] },
        { entityId: 2, modelId: 'm', values: [12.345679, 2] },
      ],
      grouping: { columnId: 'lvl', columnIds: ['lvl'], sumColumnIds: ['area'], view: 'schedule' },
    }));
    assert.strictEqual(csv.split('\r\n')[1], '12.3457,2,3');
  });

  it('an EMPTY grouping cell still exports as the "(none)" bucket, not a blank', () => {
    // Carrying raw values must not lose the bucketing vocabulary: a blank cell
    // is indistinguishable from a missing one, and `(none)` is what the table
    // view and every earlier export called it.
    const csv = toCsv(buildExportModel({
      ...base,
      rows: [{ entityId: 1, modelId: 'm', values: [null, 5] }],
      grouping: { columnId: 'lvl', columnIds: ['lvl'], sumColumnIds: ['area'], view: 'schedule' },
    }));
    assert.strictEqual(csv.split('\r\n')[1], '(none),1,5');
  });

  it('the section form carries the value in its own column, unformatted', () => {
    // The leading "Group" cell is a human path label (values joined with " / ")
    // and stays display-formatted on purpose. That loses nothing: the grouping
    // column is ALSO emitted as itself, and that copy must be the number.
    const csv = toCsv(buildExportModel({
      ...base,
      grouping: { columnId: 'lvl', columnIds: ['lvl'], sumColumnIds: ['area'] },
    }));
    const first = csv.split('\r\n')[1];
    assert.ok(first.endsWith(',-3000,1'), `Level column was not the raw number: ${first}`);
  });
});
