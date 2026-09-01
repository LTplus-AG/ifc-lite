/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite schedule` produces a tabular schedule of one IFC class. Its
 * logic-bearing parts are pure: the `Header=path` spec parser, CSV/JSON
 * rendering (which must route every cell through the shared escaper), and the
 * per-(entity, path) value resolver that reuses the `export` command's shared
 * property/quantity resolver plus the canonical attribute list. These tests
 * drive those helpers against a real parsed STEP fixture and a real `bim`
 * context, so a regression in resolution or escaping is caught without
 * spawning the full CLI pipeline.
 */

import { describe, it, expect, vi } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { createBimContext } from '@ifc-lite/sdk';
import { HeadlessBackend } from '../headless-backend.js';
import { parseColumnSpec } from './schedule-columns.js';
import {
  renderScheduleCsv,
  renderScheduleJson,
  renderScheduleCsvWithSubtotals,
  renderScheduleJsonWithSubtotals,
  type ScheduleRow,
} from './schedule-render.js';
import { resolveScheduleValue } from './schedule.js';
import { parseWhereFilter, applyWhereFilter } from './query.js';
import { parseSortSpec, parseGroupBySpec, orderRows } from './schedule-group.js';
import { parseSubtotalsSpec, buildSubtotalPlan } from './schedule-aggregate.js';

// A door carrying a Pset property (Reference), a boolean (IsExternal), a
// quantity (Qto_DoorBaseQuantities.Area), a Tag attribute, plus a second door
// whose Name contains a comma and a quote, plus a wall to prove --type filters.
const IFC = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
  '#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);',
  "#10=IFCDOOR('0Door_A_00000000000001',#1,'Door A',$,$,$,$,'D-01',2100.,900.,.DOOR.,$,$);",
  "#11=IFCDOOR('0Door_B_00000000000001',#1,'Door, \"B\"',$,$,$,$,'D-02',2100.,900.,.DOOR.,$,$);",
  "#12=IFCWALL('0Wall_C_00000000000001',#1,'Wall C',$,$,$,$,$);",
  "#20=IFCPROPERTYSINGLEVALUE('Reference',$,IFCLABEL('REF-A'),$);",
  "#21=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);",
  "#22=IFCPROPERTYSET('0Pset_A_0000000000001',#1,'Pset_DoorCommon',$,(#20,#21));",
  "#23=IFCRELDEFINESBYPROPERTIES('0Rel_A_00000000000001',#1,$,$,(#10),#22);",
  "#30=IFCPROPERTYSINGLEVALUE('Reference',$,IFCLABEL('REF-B'),$);",
  "#31=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.F.),$);",
  "#32=IFCPROPERTYSET('0Pset_B_0000000000001',#1,'Pset_DoorCommon',$,(#30,#31));",
  "#33=IFCRELDEFINESBYPROPERTIES('0Rel_B_00000000000001',#1,$,$,(#11),#32);",
  "#40=IFCQUANTITYAREA('Area',$,$,1.5,$);",
  "#41=IFCELEMENTQUANTITY('0Qto_A_0000000000001',#1,'Qto_DoorBaseQuantities',$,$,(#40));",
  "#42=IFCRELDEFINESBYPROPERTIES('0RelQ_A_0000000000001',#1,$,$,(#10),#41);",
  'ENDSEC;',
  'END-ISO-10303-21;',
  '',
].join('\n');

async function makeBim(content: string): Promise<{ bim: any; store: IfcDataStore }> {
  const bytes = new TextEncoder().encode(content);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const store = await new IfcParser().parseColumnar(buffer);
  const backend = new HeadlessBackend(store, 't.ifc');
  const bim = createBimContext({ backend });
  return { bim, store };
}

function scheduleRows(bim: any, columns: { path: string }[], entities: any[]): ScheduleRow[] {
  return entities.map(e => columns.map(c => resolveScheduleValue(e, c.path, bim)));
}

describe('parseColumnSpec', () => {
  it('parses Header=path pairs and trims whitespace', () => {
    expect(parseColumnSpec('Name=Name, Mark=Pset_DoorCommon.Reference')).toEqual([
      { header: 'Name', path: 'Name' },
      { header: 'Mark', path: 'Pset_DoorCommon.Reference' },
    ]);
  });

  it('uses a bare path as its own header', () => {
    expect(parseColumnSpec('GlobalId, Qto_DoorBaseQuantities.Area')).toEqual([
      { header: 'GlobalId', path: 'GlobalId' },
      { header: 'Qto_DoorBaseQuantities.Area', path: 'Qto_DoorBaseQuantities.Area' },
    ]);
  });

  it('splits only on the first = so a dotted path stays intact', () => {
    expect(parseColumnSpec('Area=Qto_DoorBaseQuantities.Area')).toEqual([
      { header: 'Area', path: 'Qto_DoorBaseQuantities.Area' },
    ]);
  });
});

describe('renderScheduleCsv', () => {
  const cols = [
    { header: 'Name', path: 'Name' },
    { header: 'Mark', path: 'X' },
  ];

  it('quotes a value containing a comma and escapes an embedded quote (shared escaper)', () => {
    const csv = renderScheduleCsv(cols, [['Door, "B"', 'REF-B']]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Name,Mark');
    // RFC 4180: field quoted because of the comma, inner " doubled to "".
    expect(lines[1]).toBe('"Door, ""B""",REF-B');
  });

  it('renders a missing value (null) as an empty CSV cell', () => {
    const csv = renderScheduleCsv(cols, [['Door A', null]]);
    expect(csv.split('\n')[1]).toBe('Door A,');
  });
});

describe('renderScheduleJson', () => {
  it('keys row objects by header and renders a missing value as null', () => {
    const cols = [
      { header: 'Name', path: 'Name' },
      { header: 'Mark', path: 'X' },
    ];
    expect(renderScheduleJson(cols, [['Door A', null], ['Door B', 'REF-B']])).toEqual([
      { Name: 'Door A', Mark: null },
      { Name: 'Door B', Mark: 'REF-B' },
    ]);
  });
});

describe('schedule value resolution (real fixture)', () => {
  const columns = [
    { header: 'Name', path: 'Name' },
    { header: 'Tag', path: 'Tag' },
    { header: 'Mark', path: 'Pset_DoorCommon.Reference' },
    { header: 'Area', path: 'Qto_DoorBaseQuantities.Area' },
    { header: 'Missing', path: 'Pset_DoorCommon.DoesNotExist' },
  ];

  it('resolves attributes, a pset property and a quantity; a missing path is null', async () => {
    const { bim } = await makeBim(IFC);
    const doors = bim.query().byType('IfcDoor').toArray();
    expect(doors).toHaveLength(2);

    const rows = scheduleRows(bim, columns, doors);
    const csv = renderScheduleCsv(columns, rows);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Name,Tag,Mark,Area,Missing');
    // Door A: Tag from a non-native attribute, Reference from the pset,
    // Area from the quantity set, and the unknown path an empty cell.
    expect(lines[1]).toBe('Door A,D-01,REF-A,1.5,');
    // Door B's comma+quote Name is RFC-4180 quoted by the shared escaper.
    expect(lines[2]).toBe('"Door, ""B""",D-02,REF-B,,');

    const json = renderScheduleJson(columns, rows);
    expect(json[0]).toEqual({ Name: 'Door A', Tag: 'D-01', Mark: 'REF-A', Area: 1.5, Missing: null });
    expect(json[1].Missing).toBeNull();
    // The missing quantity for Door B is null, not a crash.
    expect(json[1].Area).toBeNull();
  });

  it('--type selects only that class (the wall is excluded)', async () => {
    const { bim } = await makeBim(IFC);
    const doors = bim.query().byType('IfcDoor').toArray();
    const walls = bim.query().byType('IfcWall').toArray();
    expect(doors.map((e: any) => e.name).sort()).toEqual(['Door A', 'Door, "B"']);
    expect(walls).toHaveLength(1);
  });

  it('--where narrows rows via the shared query filter', async () => {
    const { bim } = await makeBim(IFC);
    const doors = bim.query().byType('IfcDoor').toArray();
    const parsed = parseWhereFilter('Pset_DoorCommon.IsExternal=true');
    const filtered = applyWhereFilter(doors, parsed, bim);
    expect(filtered.map((e: any) => e.name)).toEqual(['Door A']);
  });
});

// ── PR-2: sorting, grouping, subtotals ──────────────────────────────────────

/**
 * Turn `fatal()`'s `process.exit(1)` into a catchable throw so the
 * unknown-header cases can be asserted without tearing down the runner — the
 * same spy pattern the other CLI command tests use.
 */
function expectFatal(fn: () => unknown): string {
  let stderr = '';
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  try {
    fn();
    throw new Error('expected fatal() to exit, but it returned');
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith('process.exit(')) throw err;
  } finally {
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return stderr;
}

describe('parseSortSpec / orderRows (pure)', () => {
  const cols = [
    { header: 'V', path: 'V' },
  ];

  it('sorts numerically when both cells parse as numbers, not lexically', () => {
    const sortKeys = parseSortSpec('V', cols);
    const rows: ScheduleRow[] = [[10], [2], [1]];
    expect(orderRows(rows, sortKeys, [])).toEqual([[1], [2], [10]]);
  });

  it('sorts a missing/empty cell last regardless of direction', () => {
    const rows: ScheduleRow[] = [[10], [2], [null], [1]];
    expect(orderRows(rows, parseSortSpec('V:asc', cols), [])).toEqual([[1], [2], [10], [null]]);
    expect(orderRows(rows, parseSortSpec('V:desc', cols), [])).toEqual([[10], [2], [1], [null]]);
  });

  it('falls back to string compare when cells are not both numeric', () => {
    const rows: ScheduleRow[] = [['banana'], ['apple'], [null]];
    expect(orderRows(rows, parseSortSpec('V', cols), [])).toEqual([['apple'], ['banana'], [null]]);
  });

  it('multi-key: primary then secondary, numeric secondary', () => {
    const cols2 = [{ header: 'G', path: 'G' }, { header: 'N', path: 'N' }];
    const rows: ScheduleRow[] = [['b', 2], ['a', 10], ['a', 2], ['b', 1]];
    const keys = parseSortSpec('G:asc, N:asc', cols2);
    expect(orderRows(rows, keys, [])).toEqual([['a', 2], ['a', 10], ['b', 1], ['b', 2]]);
  });

  it('preserves original order as the stable tiebreaker', () => {
    const cols3 = [{ header: 'G', path: 'G' }, { header: 'N', path: 'N' }, { header: 'ID', path: 'ID' }];
    const rows: ScheduleRow[] = [['a', 5, 'first'], ['a', 5, 'second']];
    expect(orderRows(rows, parseSortSpec('G, N', cols3), [])).toEqual([
      ['a', 5, 'first'],
      ['a', 5, 'second'],
    ]);
  });
});

describe('parseGroupBySpec / orderRows grouping (pure)', () => {
  const cols = [{ header: 'G', path: 'G' }];

  it('makes each group contiguous, groups ascending by default', () => {
    const rows: ScheduleRow[] = [['b'], ['a'], ['b'], ['a']];
    const groupKeys = parseGroupBySpec('G', cols);
    expect(orderRows(rows, [], groupKeys)).toEqual([['a'], ['a'], ['b'], ['b']]);
  });

  it('follows --sort direction for the group header when it is also a sort key', () => {
    const rows: ScheduleRow[] = [['b'], ['a'], ['b'], ['a']];
    const groupKeys = parseGroupBySpec('G', cols);
    const sortKeys = parseSortSpec('G:desc', cols);
    expect(orderRows(rows, sortKeys, groupKeys)).toEqual([['b'], ['b'], ['a'], ['a']]);
  });
});

describe('unknown-header specs are fatal with the valid headers listed', () => {
  const cols = [{ header: 'Name', path: 'Name' }, { header: 'Area', path: 'Qto.Area' }];

  it('--sort on an undeclared header', () => {
    const err = expectFatal(() => parseSortSpec('Nope', cols));
    expect(err).toContain('--sort header "Nope"');
    expect(err).toContain('Valid headers: Name, Area');
  });

  it('--group-by on an undeclared header', () => {
    const err = expectFatal(() => parseGroupBySpec('Nope', cols));
    expect(err).toContain('--group-by header "Nope"');
    expect(err).toContain('Valid headers: Name, Area');
  });

  it('--subtotals sum on an undeclared header', () => {
    const err = expectFatal(() => parseSubtotalsSpec('sum:Nope', cols));
    expect(err).toContain('--subtotals header "Nope"');
    expect(err).toContain('Valid headers: Name, Area');
  });

  it('--subtotals with an unknown aggregation', () => {
    const err = expectFatal(() => parseSubtotalsSpec('median:Area', cols));
    expect(err).toContain('Unknown --subtotals aggregation');
  });
});

// Four doors across two fire-rating groups; door D has no Area quantity, so the
// aggregation must skip it (finite guard) rather than fabricate a 0.
const IFC_GROUPS = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('g.ifc','2026-01-01T00:00:00',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
  '#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);',
  "#10=IFCDOOR('0Door_A_00000000000001',#1,'Door A',$,$,$,$,'D-01',2100.,900.,.DOOR.,$,$);",
  "#11=IFCDOOR('0Door_B_00000000000001',#1,'Door B',$,$,$,$,'D-02',2100.,900.,.DOOR.,$,$);",
  "#12=IFCDOOR('0Door_C_00000000000001',#1,'Door C',$,$,$,$,'D-03',2100.,900.,.DOOR.,$,$);",
  "#13=IFCDOOR('0Door_D_00000000000001',#1,'Door D',$,$,$,$,'D-04',2100.,900.,.DOOR.,$,$);",
  // Fire ratings: A/C = REI60, B/D = REI30.
  "#20=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI60'),$);",
  "#21=IFCPROPERTYSET('0PsetA_000000000000001',#1,'Pset_DoorCommon',$,(#20));",
  "#22=IFCRELDEFINESBYPROPERTIES('0RelA_0000000000000001',#1,$,$,(#10,#12),#21);",
  "#30=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI30'),$);",
  "#31=IFCPROPERTYSET('0PsetB_000000000000001',#1,'Pset_DoorCommon',$,(#30));",
  "#32=IFCRELDEFINESBYPROPERTIES('0RelB_0000000000000001',#1,$,$,(#11,#13),#31);",
  // Areas: A=1.5, B=2.5, C=3.0; D has none.
  "#40=IFCQUANTITYAREA('Area',$,$,1.5,$);",
  "#41=IFCELEMENTQUANTITY('0QtoA_000000000000001',#1,'Qto_DoorBaseQuantities',$,$,(#40));",
  "#42=IFCRELDEFINESBYPROPERTIES('0RelQA_00000000000001',#1,$,$,(#10),#41);",
  "#50=IFCQUANTITYAREA('Area',$,$,2.5,$);",
  "#51=IFCELEMENTQUANTITY('0QtoB_000000000000001',#1,'Qto_DoorBaseQuantities',$,$,(#50));",
  "#52=IFCRELDEFINESBYPROPERTIES('0RelQB_00000000000001',#1,$,$,(#11),#51);",
  "#60=IFCQUANTITYAREA('Area',$,$,3.0,$);",
  "#61=IFCELEMENTQUANTITY('0QtoC_000000000000001',#1,'Qto_DoorBaseQuantities',$,$,(#60));",
  "#62=IFCRELDEFINESBYPROPERTIES('0RelQC_00000000000001',#1,$,$,(#12),#61);",
  'ENDSEC;',
  'END-ISO-10303-21;',
  '',
].join('\n');

describe('group-by + subtotals over a real fixture', () => {
  const columns = [
    { header: 'Name', path: 'Name' },
    { header: 'Fire', path: 'Pset_DoorCommon.FireRating' },
    { header: 'Area', path: 'Qto_DoorBaseQuantities.Area' },
  ];

  async function assembleRows(): Promise<ScheduleRow[]> {
    const { bim } = await makeBim(IFC_GROUPS);
    const doors = bim.query().byType('IfcDoor').toArray();
    expect(doors).toHaveLength(4);
    return doors.map((e: any) => columns.map(c => resolveScheduleValue(e, c.path, bim)));
  }

  it('groups contiguously, subtotals count + sum:Area per group, and a grand total (CSV)', async () => {
    const rows = await assembleRows();
    const groupKeys = parseGroupBySpec('Fire', columns);
    const aggs = parseSubtotalsSpec('count, sum:Area', columns);
    const ordered = orderRows(rows, [], groupKeys);
    const plan = buildSubtotalPlan(ordered, groupKeys, aggs);
    const lines = renderScheduleCsvWithSubtotals(columns, plan).split('\n');

    expect(lines).toEqual([
      'Name,Fire,Area',
      'Door B,REI30,2.5',
      'Door D,REI30,',
      ',Subtotal (Fire=REI30): 2,2.5',
      'Door A,REI60,1.5',
      'Door C,REI60,3',
      ',Subtotal (Fire=REI60): 2,4.5',
      'Total: 4,,7',
    ]);
  });

  it('emits __row markers with group + aggregated fields (JSON)', async () => {
    const rows = await assembleRows();
    const groupKeys = parseGroupBySpec('Fire', columns);
    const aggs = parseSubtotalsSpec('count, sum:Area', columns);
    const ordered = orderRows(rows, [], groupKeys);
    const plan = buildSubtotalPlan(ordered, groupKeys, aggs);
    const json = renderScheduleJsonWithSubtotals(columns, plan);

    expect(json).toEqual([
      { Name: 'Door B', Fire: 'REI30', Area: 2.5 },
      { Name: 'Door D', Fire: 'REI30', Area: null },
      { __row: 'subtotal', Fire: 'REI30', count: 2, 'sum:Area': 2.5 },
      { Name: 'Door A', Fire: 'REI60', Area: 1.5 },
      { Name: 'Door C', Fire: 'REI60', Area: 3 },
      { __row: 'subtotal', Fire: 'REI60', count: 2, 'sum:Area': 4.5 },
      { __row: 'total', count: 4, 'sum:Area': 7 },
    ]);
  });

  it('--subtotals without --group-by yields only the grand-total row', async () => {
    const rows = await assembleRows();
    const aggs = parseSubtotalsSpec('count, sum:Area', columns);
    // No sort/group: rows stay in entity order (A, B, C, D).
    const plan = buildSubtotalPlan(rows, [], aggs);
    expect(plan.groups).toHaveLength(0);

    const lines = renderScheduleCsvWithSubtotals(columns, plan).split('\n');
    expect(lines).toEqual([
      'Name,Fire,Area',
      'Door A,REI60,1.5',
      'Door B,REI30,2.5',
      'Door C,REI60,3',
      'Door D,REI30,',
      'Total: 4,,7',
    ]);

    const json = renderScheduleJsonWithSubtotals(columns, plan);
    expect(json.filter(r => r.__row === 'subtotal')).toHaveLength(0);
    expect(json[json.length - 1]).toEqual({ __row: 'total', count: 4, 'sum:Area': 7 });
  });
});
