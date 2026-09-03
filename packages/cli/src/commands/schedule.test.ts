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
  subtotalCells,
  type ScheduleRow,
} from './schedule-render.js';
import { resolveScheduleValue, scheduleCommand } from './schedule.js';
import { parseWhereFilter, applyWhereFilter } from './query.js';
import { parseSortSpec, parseGroupBySpec, orderRows } from './schedule-group.js';
import { parseSubtotalsSpec, buildSubtotalPlan } from './schedule-aggregate.js';
import { SCHEDULE_PRESETS, resolvePreset } from './schedule-presets.js';
import { renderScheduleMarkdown, renderScheduleMarkdownWithSubtotals } from './schedule-render-md.js';
import { renderScheduleHtml, renderScheduleHtmlWithSubtotals } from './schedule-render-html.js';
import { loadScheduleSpec, saveScheduleSpec } from './schedule-spec.js';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('rejects a duplicate header naming both colliding specs', () => {
    const err = expectFatal(() =>
      parseColumnSpec('Area=Qto_WallBaseQuantities.NetArea, Area=Qto_WallBaseQuantities.GrossArea'),
    );
    expect(err).toContain('Area=Qto_WallBaseQuantities.NetArea');
    expect(err).toContain('Area=Qto_WallBaseQuantities.GrossArea');
  });

  it('is case-sensitive: "Area" and "area" are distinct headers', () => {
    expect(parseColumnSpec('Area=X, area=Y')).toEqual([
      { header: 'Area', path: 'X' },
      { header: 'area', path: 'Y' },
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

// A door carrying a user-authored Pset property literally named "Tag" whose
// value differs from the door's own schema Tag attribute ('D-99') — proves a
// bare (dot-free) path resolves the canonical schema attribute, not
// whichever property set happens to share its name.
const IFC_TAG_SHADOW = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('shadow.ifc','2026-01-01T00:00:00',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
  '#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);',
  "#10=IFCDOOR('0Door_S_00000000000001',#1,'Door S',$,$,$,$,'D-99',2100.,900.,.DOOR.,$,$);",
  "#20=IFCPROPERTYSINGLEVALUE('Tag',$,IFCLABEL('PSET-TAG-VALUE'),$);",
  "#21=IFCPROPERTYSET('0Pset_S_0000000000001',#1,'Pset_Custom',$,(#20));",
  "#22=IFCRELDEFINESBYPROPERTIES('0Rel_S_00000000000001',#1,$,$,(#10),#21);",
  'ENDSEC;',
  'END-ISO-10303-21;',
  '',
].join('\n');

describe('bare-path resolution reads the schema attribute before a same-named pset property', () => {
  /**
   * Bug: resolveScheduleValue consulted resolveColumnValue's pset/qset sweep
   * BEFORE the canonical entity-attribute list for a bare (dot-free) path.
   * resolveColumnValue's own bare-name fallback sweeps EVERY property set
   * for a property with that literal name, so a pset property named "Tag"
   * (not among resolveColumnValue's 5-attribute native whitelist) shadowed
   * IfcDoor.Tag itself — --preset door's Mark=Tag column resolved to the
   * pset value instead of the schema attribute the doc comment already
   * claimed it would.
   */
  it('IfcDoor.Tag wins over a Pset property also named "Tag"', async () => {
    const { bim } = await makeBim(IFC_TAG_SHADOW);
    const doors = bim.query().byType('IfcDoor').toArray();
    expect(doors).toHaveLength(1);
    expect(resolveScheduleValue(doors[0], 'Tag', bim)).toBe('D-99');
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

/** Async twin of `expectFatal` for `fatal()` calls reached through an `await` (spec loading, `scheduleCommand`). */
async function expectFatalAsync(fn: () => Promise<unknown>): Promise<string> {
  let stderr = '';
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  try {
    await fn();
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

  /**
   * Bug: compareCell used to decide numeric-vs-string PER PAIR ("both cells
   * individually numeric" -> numeric, else string). That is intransitive
   * once a column mixes clean numbers with a non-numeric string: 2 vs 10
   * compares numerically (2 < 10), but 2 vs '1x' falls back to string
   * compare ('1x' vs '2' lexically), so the overall order depends on
   * comparison order rather than forming one consistent ranking — the
   * textbook Array.sort() hazard for a non-transitive comparator. Deciding
   * the mode once per COLUMN (numeric only when every non-blank cell in it
   * parses as a number) fixes this: '1x' makes the whole column a string
   * sort, matching a plain localeCompare oracle over every value exactly.
   */
  it('decides numeric-vs-string per COLUMN, not per compared pair (fixes an intransitive sort)', () => {
    const rows: ScheduleRow[] = [['2'], ['10'], ['1x'], ['3']];
    const sorted = orderRows(rows, parseSortSpec('V', cols), []);
    const oracle = ['2', '10', '1x', '3'].slice().sort((a, b) => a.localeCompare(b));
    expect(sorted.map(r => r[0])).toEqual(oracle);
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

describe('group-boundary canonicalisation agrees with the sorter (pure)', () => {
  const cols = [{ header: 'G', path: 'G' }, { header: 'V', path: 'V' }];

  /**
   * Bug: orderRows' compareCell treats '1' and '1.0' as numerically equal
   * (both parse to 1), so they land adjacent and contiguous after
   * ordering — but buildSubtotalPlan's sameGroup compared the RAW
   * `String(value)` ('1' !== '1.0'), splitting one conceptual group into
   * two separate contiguous runs and emitting two "Subtotal (G=...)"
   * headings for what a numeric column treats as one group.
   */
  it('a numeric-looking column groups "1" and "1.0" as ONE group, not two', () => {
    const rows: ScheduleRow[] = [['1', 'a'], ['1.0', 'b'], ['2', 'c']];
    const groupKeys = parseGroupBySpec('G', cols);
    const ordered = orderRows(rows, [], groupKeys);
    const aggs = parseSubtotalsSpec('count', cols);
    const plan = buildSubtotalPlan(ordered, groupKeys, aggs);
    expect(plan.groups).toHaveLength(2); // {1, 1.0} together, {2} alone
    expect(plan.groups[0].rows).toHaveLength(2);
    expect(plan.groups[0].subtotal.groupValues[0].value).toBe('1');
  });

  /**
   * Bug companion: compareCell's `isNullish` treats `null` and a
   * whitespace-only string as the SAME "sorts last" bucket (so they end up
   * adjacent), but sameGroup's raw `String(value)` treated `null` ('') and
   * `'   '` as different keys, splitting them into two subtotal groups.
   */
  it('groups null and a whitespace-only cell together as one blank group', () => {
    const rows: ScheduleRow[] = [[null, 'a'], ['   ', 'b'], ['x', 'c']];
    const groupKeys = parseGroupBySpec('G', cols);
    const ordered = orderRows(rows, [], groupKeys);
    const aggs = parseSubtotalsSpec('count', cols);
    const plan = buildSubtotalPlan(ordered, groupKeys, aggs);
    expect(plan.groups).toHaveLength(2); // {null, '   '} together, {'x'} alone
    const blankGroup = plan.groups.find(g => g.rows.length === 2)!;
    expect(blankGroup.rows).toHaveLength(2);
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

  /**
   * Bug: the grand-total label is forced into column 0 whenever there is no
   * --group-by. When --subtotals aggregates column 0 itself (Area here),
   * `idx === labelCol` in subtotalCells silently skips writing the
   * aggregated value there — the sum vanishes from CSV/Markdown/HTML while
   * JSON (which builds the row from `data.values` directly, not fixed
   * column slots) still reports it correctly. CSV and JSON must agree.
   */
  it('CSV/MD do not drop a subtotal whose target column is column 0 — they agree with JSON', async () => {
    const colsAreaFirst = [
      { header: 'Area', path: 'Qto_DoorBaseQuantities.Area' },
      { header: 'Name', path: 'Name' },
    ];
    const { bim } = await makeBim(IFC_GROUPS);
    const doors = bim.query().byType('IfcDoor').toArray();
    const rows = doors.map((e: any) => colsAreaFirst.map(c => resolveScheduleValue(e, c.path, bim)));
    const aggs = parseSubtotalsSpec('sum:Area', colsAreaFirst);
    const plan = buildSubtotalPlan(rows, [], aggs);

    const json = renderScheduleJsonWithSubtotals(colsAreaFirst, plan);
    const jsonTotal = json[json.length - 1] as Record<string, unknown>;
    expect(jsonTotal['sum:Area']).toBe(7);

    const csvLines = renderScheduleCsvWithSubtotals(colsAreaFirst, plan).split('\n');
    const csvTotal = csvLines[csvLines.length - 1].split(',');
    // Area's own column must carry the sum, exactly like JSON — wherever the
    // label ends up, it must not be the column an aggregation targets.
    expect(Number(csvTotal[0])).toBe(7);
    expect(csvTotal[0]).not.toBe('Total');

    const mdLines = renderScheduleMarkdownWithSubtotals(colsAreaFirst, plan).split('\n');
    const mdTotal = mdLines[mdLines.length - 1];
    expect(mdTotal).toContain('7');
  });
});

describe('two --subtotals aggregations targeting the same column do not collide', () => {
  const columns = [
    { header: 'Name', path: 'Name' },
    { header: 'Area', path: 'Area' },
  ];

  // total.values = [{ spec: 'sum:Area', value: 30 }, { spec: 'avg:Area', value: 15 }]
  const total = {
    kind: 'total' as const,
    groupValues: [],
    values: [
      { spec: 'sum:Area', value: 30 },
      { spec: 'avg:Area', value: 15 },
    ],
  };

  it('subtotalCells keeps both values instead of the second silently overwriting the first', () => {
    const cells = subtotalCells(columns, total);
    const areaCell = String(cells[1]);
    expect(areaCell).toContain('30');
    expect(areaCell).toContain('15');
  });

  it('CSV keeps both aggregations in the Total row', () => {
    const rows: ScheduleRow[] = [['Door A', 10], ['Door B', 20]];
    const plan = { rows, groups: [], total };
    const csv = renderScheduleCsvWithSubtotals(columns, plan);
    const totalLine = csv.split('\n').find(l => l.startsWith('Total'))!;
    expect(totalLine).toContain('30');
    expect(totalLine).toContain('15');
  });

  it('Markdown keeps both aggregations in the Total row', () => {
    const rows: ScheduleRow[] = [['Door A', 10], ['Door B', 20]];
    const plan = { rows, groups: [], total };
    const md = renderScheduleMarkdownWithSubtotals(columns, plan);
    const totalLine = md.split('\n').find(l => l.startsWith('| Total'))!;
    expect(totalLine).toContain('30');
    expect(totalLine).toContain('15');
  });

  it('HTML keeps both aggregations in the Total row', () => {
    const rows: ScheduleRow[] = [['Door A', 10], ['Door B', 20]];
    const plan = { rows, groups: [], total };
    const html = renderScheduleHtmlWithSubtotals(columns, plan);
    // Find the Total row's Area cell content: it must contain both values.
    const totalRowMatch = html.match(/<tr[^>]*>\s*<td[^>]*>Total<\/td>[\s\S]*?<\/tr>/);
    expect(totalRowMatch).not.toBeNull();
    expect(totalRowMatch![0]).toContain('30');
    expect(totalRowMatch![0]).toContain('15');
  });

  it('JSON already keeps both (spec-keyed) — control, must keep passing', () => {
    const rows: ScheduleRow[] = [['Door A', 10], ['Door B', 20]];
    const plan = { rows, groups: [], total };
    const json = renderScheduleJsonWithSubtotals(columns, plan);
    const totalRow = json[json.length - 1];
    expect(totalRow['sum:Area']).toBe(30);
    expect(totalRow['avg:Area']).toBe(15);
  });

  it('control: a single sum:Area still renders as a plain numeric-looking cell', () => {
    const singleTotal = {
      kind: 'total' as const,
      groupValues: [],
      values: [{ spec: 'sum:Area', value: 30 }],
    };
    const cells = subtotalCells(columns, singleTotal);
    expect(cells[1]).toBe(30);
  });
});

// ── PR-3: presets ───────────────────────────────────────────────────────────

/** Header row produced by rendering a preset's declared columns, no data. */
function presetHeaderRow(name: string): string {
  const cols = parseColumnSpec(SCHEDULE_PRESETS[name].columns);
  return renderScheduleCsv(cols, []).split('\n')[0];
}

describe('resolvePreset (declared type + columns)', () => {
  it('door resolves IfcDoor with the standard door column set', () => {
    expect(SCHEDULE_PRESETS.door.type).toBe('IfcDoor');
    expect(presetHeaderRow('door')).toBe('Mark,Name,FireRating,IsExternal,Width,Height');
  });

  it('space resolves IfcSpace with the standard space columns and a NetFloorArea:desc default sort', () => {
    expect(SCHEDULE_PRESETS.space.type).toBe('IfcSpace');
    expect(presetHeaderRow('space')).toBe('Number,LongName,Category,NetFloorArea,NetVolume');
    expect(SCHEDULE_PRESETS.space.sort).toBe('NetFloorArea:desc');
  });

  it('window and wall resolve their IFC types', () => {
    expect(SCHEDULE_PRESETS.window.type).toBe('IfcWindow');
    expect(SCHEDULE_PRESETS.wall.type).toBe('IfcWall');
  });

  it('material-takeoff groups a Material pseudo-column with a summed NetVolume', () => {
    const p = SCHEDULE_PRESETS['material-takeoff'];
    expect(presetHeaderRow('material-takeoff')).toBe('Material,NetVolume');
    expect(p.groupBy).toBe('Material');
    expect(p.subtotals).toBe('count, sum:NetVolume');
  });

  it('an unknown preset name is fatal, listing the valid presets', () => {
    const err = expectFatal(() => resolvePreset('nope'));
    expect(err).toContain('Unknown --preset "nope"');
    expect(err).toContain('door');
    expect(err).toContain('material-takeoff');
  });
});

/** Run `scheduleCommand` against a temp fixture and capture its stdout. */
async function runSchedule(content: string, args: string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'sched-'));
  const file = join(dir, 't.ifc');
  writeFileSync(file, content);
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  try {
    await scheduleCommand([file, ...args]);
  } finally {
    spy.mockRestore();
  }
  return out;
}

describe('scheduleCommand --preset (end to end)', () => {
  it('--preset door emits the preset header row and resolves its columns', async () => {
    const out = await runSchedule(IFC, ['--preset', 'door']);
    const lines = out.trimEnd().split('\n');
    expect(lines[0]).toBe('Mark,Name,FireRating,IsExternal,Width,Height');
    // D-01 door: Tag=D-01, Name='Door A', IsExternal=true; no FireRating/Width/Height.
    expect(lines).toContain('D-01,Door A,,true,,');
  });

  it('explicit --columns overrides the preset column set (explicit flag wins)', async () => {
    const out = await runSchedule(IFC, ['--preset', 'door', '--columns', 'X=Name']);
    const lines = out.trimEnd().split('\n');
    expect(lines[0]).toBe('X');
    expect(lines).toContain('Door A');
  });

  it('explicit --type overrides the preset type default (explicit flag wins)', async () => {
    // door preset selects IfcDoor; an explicit --type IfcWall must schedule the
    // wall instead — proving the flag, not the preset default, decides --type.
    const out = await runSchedule(IFC, ['--preset', 'door', '--type', 'IfcWall']);
    const lines = out.trimEnd().split('\n');
    expect(lines[0]).toBe('Mark,Name,FireRating,IsExternal,Width,Height');
    expect(lines).toContain(',Wall C,,,,');
    expect(lines).not.toContain('D-01,Door A,,true,,');
  });
});

// A wall carrying an associated IfcMaterial, to prove the `Material`
// pseudo-column resolves through the shared material accessor.
const IFC_MATERIAL = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('m.ifc','2026-01-01T00:00:00',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
  '#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);',
  "#10=IFCWALL('0Wall_M_00000000000001',#1,'Wall M',$,$,$,$,$);",
  "#50=IFCMATERIAL('Concrete',$,$);",
  "#51=IFCRELASSOCIATESMATERIAL('0Rel_M_00000000000001',#1,$,$,(#10),#50);",
  'ENDSEC;',
  'END-ISO-10303-21;',
  '',
].join('\n');

// A wall associated through an IfcMaterialLayerSet (no top-level LayerSetName)
// whose sole layer names the real material — the normal IfcWall shape, and
// the default association `--preset material-takeoff` schedules. `Material`
// resolving only `materials[0]`/`.name` (the pre-fix behaviour) finds neither
// field on a layer set and returns null for every wall, collapsing the
// preset's `--group-by Material` into one unlabelled group.
const IFC_MATERIAL_LAYERSET = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('m2.ifc','2026-01-01T00:00:00',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
  '#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);',
  "#10=IFCWALL('0Wall_L_00000000000001',#1,'Wall L',$,$,$,$,$);",
  "#50=IFCMATERIAL('Concrete Layer',$,$);",
  '#51=IFCMATERIALLAYER(#50,0.2,$,$,$,$,$);',
  '#52=IFCMATERIALLAYERSET((#51),$,$);',
  "#53=IFCRELASSOCIATESMATERIAL('0Rel_L_00000000000001',#1,$,$,(#10),#52);",
  // A second wall whose layer set's sole layer material Name is
  // whitespace-only — must fall through to the placeholder, not be
  // returned verbatim (the blank/whitespace family of defects, #3714).
  "#60=IFCWALL('0Wall_W_00000000000001',#1,'Wall W',$,$,$,$,$);",
  "#70=IFCMATERIAL('   ',$,$);",
  '#71=IFCMATERIALLAYER(#70,0.1,$,$,$,$,$);',
  '#72=IFCMATERIALLAYERSET((#71),$,$);',
  "#73=IFCRELASSOCIATESMATERIAL('0Rel_W_00000000000001',#1,$,$,(#60),#72);",
  'ENDSEC;',
  'END-ISO-10303-21;',
  '',
].join('\n');

describe('Material pseudo-column', () => {
  it('resolves an element’s associated material name via bim.materials', async () => {
    const { bim } = await makeBim(IFC_MATERIAL);
    const walls = bim.query().byType('IfcWall').toArray();
    expect(walls).toHaveLength(1);
    expect(resolveScheduleValue(walls[0], 'Material', bim)).toBe('Concrete');
  });

  it('falls through layers/profiles/constituents to the leaf material name (MaterialLayerSet, no top-level LayerSetName)', async () => {
    const { bim } = await makeBim(IFC_MATERIAL_LAYERSET);
    const walls = bim.query().byType('IfcWall').toArray();
    const wallL = walls.find((w: any) => w.name === 'Wall L');
    expect(resolveScheduleValue(wallL, 'Material', bim)).toBe('Concrete Layer');
  });

  it('groups a whitespace-only layer material name as "(no material)", like `query --group-by material`', async () => {
    const { bim } = await makeBim(IFC_MATERIAL_LAYERSET);
    const walls = bim.query().byType('IfcWall').toArray();
    const wallW = walls.find((w: any) => w.name === 'Wall W');
    expect(resolveScheduleValue(wallW, 'Material', bim)).toBe('(no material)');
  });

  it('material-takeoff preset groups a MaterialLayerSet wall under its real material, not a collapsed blank group', async () => {
    const columns = [{ header: 'Material', path: 'Material' }, { header: 'NetVolume', path: 'Qto_WallBaseQuantities.NetVolume' }];
    const { bim } = await makeBim(IFC_MATERIAL_LAYERSET);
    const walls = bim.query().byType('IfcWall').toArray();
    const rows = scheduleRows(bim, columns, walls);
    const groupKeys = parseGroupBySpec('Material', columns);
    const ordered = orderRows(rows, [], groupKeys);
    const materials = ordered.map(r => r[0]);
    // Two distinct real materials, not one shared `null`/blank bucket.
    expect(new Set(materials)).toEqual(new Set(['Concrete Layer', '(no material)']));
  });
});

// ── PR-4: Markdown / HTML renderers, --save/--spec ──────────────────────────

describe('renderScheduleMarkdown', () => {
  const cols = [
    { header: 'Name', path: 'Name' },
    { header: 'Mark', path: 'X' },
  ];

  it('renders a GFM table with header, separator, and data rows', () => {
    const md = renderScheduleMarkdown(cols, [['Door A', 'D-01'], ['Door B', 'D-02']]);
    expect(md.split('\n')).toEqual([
      '| Name | Mark |',
      '| --- | --- |',
      '| Door A | D-01 |',
      '| Door B | D-02 |',
    ]);
  });

  it('renders a missing value as an empty cell', () => {
    const md = renderScheduleMarkdown(cols, [['Door A', null]]);
    expect(md.split('\n')[2]).toBe('| Door A |  |');
  });

  it('escapes a `|` in a value so it cannot fracture the table row', () => {
    const md = renderScheduleMarkdown(cols, [['A|B', 'X']]);
    expect(md.split('\n')[2]).toBe('| A\\|B | X |');
  });

  it('escapes a backslash before escaping `|`, and turns an embedded newline into <br>', () => {
    const md = renderScheduleMarkdown(cols, [['back\\slash', 'line1\nline2']]);
    const dataLine = md.split('\n')[2];
    expect(dataLine).toBe('| back\\\\slash | line1<br>line2 |');
  });
});

describe('renderScheduleMarkdownWithSubtotals', () => {
  const columns = [
    { header: 'Name', path: 'Name' },
    { header: 'Fire', path: 'Fire' },
    { header: 'Area', path: 'Area' },
  ];

  it('groups contiguously with a subtotal row per group and a grand total, same shape as CSV', () => {
    const rows: ScheduleRow[] = [
      ['Door B', 'REI30', 2.5],
      ['Door D', 'REI30', null],
      ['Door A', 'REI60', 1.5],
      ['Door C', 'REI60', 3],
    ];
    const groupKeys = parseGroupBySpec('Fire', columns);
    const aggs = parseSubtotalsSpec('count, sum:Area', columns);
    const plan = buildSubtotalPlan(rows, groupKeys, aggs);
    const lines = renderScheduleMarkdownWithSubtotals(columns, plan).split('\n');

    expect(lines).toEqual([
      '| Name | Fire | Area |',
      '| --- | --- | --- |',
      '| Door B | REI30 | 2.5 |',
      '| Door D | REI30 |  |',
      '|  | Subtotal (Fire=REI30): 2 | 2.5 |',
      '| Door A | REI60 | 1.5 |',
      '| Door C | REI60 | 3 |',
      '|  | Subtotal (Fire=REI60): 2 | 4.5 |',
      '| Total: 4 |  | 7 |',
    ]);
  });
});

describe('renderScheduleHtml', () => {
  const cols = [
    { header: 'Name', path: 'Name' },
    { header: 'Mark', path: 'X' },
  ];

  it('renders a standalone HTML document with a header row and data rows', () => {
    const html = renderScheduleHtml(cols, [['Door A', 'D-01']]);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<title>Schedule</title>');
    expect(html).toContain('<thead><tr><th>Name</th><th>Mark</th></tr></thead>');
    expect(html).toContain('<tr><td>Door A</td><td>D-01</td></tr>');
  });

  it('renders a missing value as an empty cell', () => {
    const html = renderScheduleHtml(cols, [['Door A', null]]);
    expect(html).toContain('<tr><td>Door A</td><td></td></tr>');
  });

  it('escapes &, <, > and quotes so untrusted model text cannot break out of the cell', () => {
    const html = renderScheduleHtml(cols, [['<script>alert(1)</script>', 'A & B "C" \'D\'']]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('A &amp; B &quot;C&quot; &#39;D&#39;');
  });
});

describe('renderScheduleHtmlWithSubtotals', () => {
  const columns = [
    { header: 'Name', path: 'Name' },
    { header: 'Fire', path: 'Fire' },
    { header: 'Area', path: 'Area' },
  ];

  it('groups contiguously with a subtotal <tr> per group and a grand-total <tr>, same shape as CSV', () => {
    const rows: ScheduleRow[] = [
      ['Door B', 'REI30', 2.5],
      ['Door D', 'REI30', null],
      ['Door A', 'REI60', 1.5],
      ['Door C', 'REI60', 3],
    ];
    const groupKeys = parseGroupBySpec('Fire', columns);
    const aggs = parseSubtotalsSpec('count, sum:Area', columns);
    const plan = buildSubtotalPlan(rows, groupKeys, aggs);
    const html = renderScheduleHtmlWithSubtotals(columns, plan);

    expect(html).toContain('<tr><td>Door B</td><td>REI30</td><td>2.5</td></tr>');
    expect(html).toContain('<tr class="subtotal"><td></td><td>Subtotal (Fire=REI30): 2</td><td>2.5</td></tr>');
    expect(html).toContain('<tr class="subtotal"><td></td><td>Subtotal (Fire=REI60): 2</td><td>4.5</td></tr>');
    expect(html).toContain('<tr class="total"><td>Total: 4</td><td></td><td>7</td></tr>');
  });
});

describe('scheduleCommand --format md/html (end to end)', () => {
  it('--format md emits a GFM table for the preset door schedule', async () => {
    const out = await runSchedule(IFC, ['--preset', 'door', '--format', 'md']);
    const lines = out.trimEnd().split('\n');
    expect(lines[0]).toBe('| Mark | Name | FireRating | IsExternal | Width | Height |');
    expect(lines[1]).toBe('| --- | --- | --- | --- | --- | --- |');
    expect(lines).toContain('| D-01 | Door A |  | true |  |  |');
  });

  it('--format html emits a standalone document escaping the comma+quote door name', async () => {
    const out = await runSchedule(IFC, ['--preset', 'door', '--format', 'html']);
    expect(out).toContain('<!doctype html>');
    // Door B's Name is `Door, "B"` — the quotes must be entity-escaped, not raw.
    expect(out).toContain('Door, &quot;B&quot;');
    expect(out).not.toContain('Door, "B"');
  });
});

describe('--spec / --save', () => {
  it('--save writes a spec that --spec reloads to the identical output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-spec-'));
    const specPath = join(dir, 'door.json');

    const saved = await runSchedule(IFC, ['--preset', 'door', '--save', specPath]);
    const reloaded = await runSchedule(IFC, ['--spec', specPath]);
    expect(reloaded).toBe(saved);

    const spec = JSON.parse(readFileSync(specPath, 'utf-8'));
    expect(spec.type).toBe('IfcDoor');
    expect(spec.columns).toContain('Mark=Tag');
    expect(spec.format).toBe('csv');
  });

  /**
   * Bug: --save wrote the spec file BEFORE --where was parsed and before the
   * input .ifc was even opened. An invalid --where (or a nonexistent input
   * file) still fatals, but only after a spec file already landed on disk —
   * a broken definition persisted despite the command's own non-zero exit.
   * --save must only happen once the run it is capturing has actually
   * succeeded.
   */
  it('--save does not leave a spec file on disk when --where is invalid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-spec-'));
    const specPath = join(dir, 'broken.json');
    await expectFatalAsync(() =>
      runSchedule(IFC, ['--type', 'IfcDoor', '--columns', 'Name=Name', '--where', 'NotAValidWhereExpr', '--save', specPath]),
    );
    expect(existsSync(specPath)).toBe(false);
  });

  it('--save does not leave a spec file on disk when the input file does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-spec-'));
    const specPath = join(dir, 'broken2.json');
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    try {
      await expect(
        scheduleCommand(['/nonexistent/model.ifc', '--type', 'IfcDoor', '--columns', 'Name=Name', '--save', specPath]),
      ).rejects.toThrow();
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
    expect(existsSync(specPath)).toBe(false);
  });

  it('an explicit flag overrides the loaded spec (explicit flag wins)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-spec-'));
    const specPath = join(dir, 'door.json');
    await saveScheduleSpec(specPath, { type: 'IfcDoor', columns: 'Name=Name' });

    const out = await runSchedule(IFC, ['--spec', specPath, '--columns', 'X=Name']);
    expect(out.trimEnd().split('\n')[0]).toBe('X');
  });

  it('an explicit --sort overrides the spec sort field (explicit flag wins)', async () => {
    // Ascending 'Name' puts "Door A" before 'Door, "B"' (space < comma); an
    // explicit --sort Name:desc must flip that, proving the flag — not the
    // spec's own sort default — decides ordering.
    const dir = mkdtempSync(join(tmpdir(), 'sched-spec-'));
    const specPath = join(dir, 'door-sort.json');
    await saveScheduleSpec(specPath, { type: 'IfcDoor', columns: 'Name=Name', sort: 'Name:asc' });

    const ascOut = await runSchedule(IFC, ['--spec', specPath]);
    const ascLines = ascOut.trimEnd().split('\n');
    expect(ascLines[1]).toBe('Door A');

    const descOut = await runSchedule(IFC, ['--spec', specPath, '--sort', 'Name:desc']);
    const descLines = descOut.trimEnd().split('\n');
    expect(descLines[1]).toContain('B');
    expect(descLines[1]).not.toBe('Door A');
  });

  it('loadScheduleSpec round-trips every field saveScheduleSpec writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-spec-'));
    const specPath = join(dir, 'full.json');
    await saveScheduleSpec(specPath, {
      type: 'IfcDoor', columns: 'Name=Name', where: 'Pset_DoorCommon.IsExternal=true',
      sort: 'Name', groupBy: 'Name', subtotals: 'count', format: 'json',
    });
    const spec = await loadScheduleSpec(specPath);
    expect(spec).toEqual({
      type: 'IfcDoor', columns: 'Name=Name', where: 'Pset_DoorCommon.IsExternal=true',
      sort: 'Name', groupBy: 'Name', subtotals: 'count', format: 'json',
    });
  });

  it('a nonexistent --spec file is fatal, not a silently empty schedule', async () => {
    const err = await expectFatalAsync(() => runSchedule(IFC, ['--spec', '/nonexistent/spec.json']));
    expect(err).toContain('--spec "/nonexistent/spec.json" could not be read');
  });

  /**
   * Bug: an unrecognised field (a mistyped "group-by" instead of the real
   * "groupBy") used to be silently ignored by the `field in obj` / `for
   * (const field of SPEC_FIELDS)` loop, which only reads the fields it
   * already knows about — so the mistyped key had no effect and the command
   * exited 0 with an ungrouped schedule instead of the grouped one the
   * author of the spec clearly intended. Any key outside SPEC_FIELDS is now
   * a fatal(...) naming the bad key.
   */
  it('a spec with an unrecognised field (mistyped "group-by") is fatal, not a silent no-op', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-spec-'));
    const specPath = join(dir, 'typo.json');
    writeFileSync(specPath, JSON.stringify({ type: 'IfcDoor', columns: 'Name=Name', 'group-by': 'Name' }));
    const err = await expectFatalAsync(() => loadScheduleSpec(specPath));
    expect(err).toContain('group-by');
  });

  /** A spec's `where` is validated the same way an explicit --where is (parseWhereFilter), not deferred until the run tries to apply it. */
  it('a spec with an invalid `where` expression is fatal at load time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-spec-'));
    const specPath = join(dir, 'bad-where.json');
    writeFileSync(specPath, JSON.stringify({ type: 'IfcDoor', columns: 'Name=Name', where: 'NotAValidWhereExpr' }));
    const err = await expectFatalAsync(() => loadScheduleSpec(specPath));
    expect(err).toContain('Invalid --where syntax');
  });

  it('invalid JSON in --spec is fatal with a clear message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-spec-'));
    const specPath = join(dir, 'bad.json');
    writeFileSync(specPath, '{not json');
    const err = await expectFatalAsync(() => loadScheduleSpec(specPath));
    expect(err).toContain('is not valid JSON');
  });

  it('a --spec that is a JSON array (not an object) is fatal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-spec-'));
    const specPath = join(dir, 'array.json');
    writeFileSync(specPath, '[1, 2, 3]');
    const err = await expectFatalAsync(() => loadScheduleSpec(specPath));
    expect(err).toContain('must be a JSON object');
  });

  it('a --spec field with the wrong type is fatal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-spec-'));
    const specPath = join(dir, 'wrong-type.json');
    writeFileSync(specPath, JSON.stringify({ type: 'IfcDoor', columns: ['Name=Name'] }));
    const err = await expectFatalAsync(() => loadScheduleSpec(specPath));
    expect(err).toContain('field "columns" must be a string');
  });

  it('a --spec with neither "type" nor "preset" is fatal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-spec-'));
    const specPath = join(dir, 'empty.json');
    writeFileSync(specPath, JSON.stringify({ where: 'x=1' }));
    const err = await expectFatalAsync(() => loadScheduleSpec(specPath));
    expect(err).toContain('declares neither "preset" nor "type"');
  });

  it('a --spec naming an unresolvable preset is fatal, listing the valid presets (not an empty schedule)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-spec-'));
    const specPath = join(dir, 'bad-preset.json');
    writeFileSync(specPath, JSON.stringify({ preset: 'nonexistent-preset' }));
    const err = await expectFatalAsync(() => runSchedule(IFC, ['--spec', specPath]));
    expect(err).toContain('Unknown --preset "nonexistent-preset"');
    expect(err).toContain('door');
  });

  it('--spec preset field resolves the same as --preset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-spec-'));
    const specPath = join(dir, 'preset-ref.json');
    writeFileSync(specPath, JSON.stringify({ preset: 'door' }));
    const out = await runSchedule(IFC, ['--spec', specPath]);
    expect(out.trimEnd().split('\n')[0]).toBe('Mark,Name,FireRating,IsExternal,Width,Height');
  });
});
