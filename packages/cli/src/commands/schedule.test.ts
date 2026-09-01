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

import { describe, it, expect } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { createBimContext } from '@ifc-lite/sdk';
import { HeadlessBackend } from '../headless-backend.js';
import { parseColumnSpec } from './schedule-columns.js';
import { renderScheduleCsv, renderScheduleJson, type ScheduleRow } from './schedule-render.js';
import { resolveScheduleValue } from './schedule.js';
import { parseWhereFilter, applyWhereFilter } from './query.js';

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
