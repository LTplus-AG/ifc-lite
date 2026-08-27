/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `Type` column of a CSV or JSON export names the class the STEP line
 * DECLARES, not the class the viewer groups it under.
 *
 * `IfcTypeEnum` coalesces several spellings onto one value so the scope chips
 * render one chip per family, and `EntityTable.getTypeName` resolves through
 * that enum — so an `IFCDOORSTANDARDCASE` line exported as `IfcDoor`, an
 * `IFCSLABSTANDARDCASE` as `IfcSlab`, and both `IFCDISTRIBUTIONFLOWELEMENT`
 * and `IFCDISTRIBUTIONCONTROLELEMENT` as `IfcDistributionElement`, while
 * `IFCWALLSTANDARDCASE` survived only because it happens to hold its own enum
 * value. The Parquet exporter was fixed to use `exactTypeName`; CSV and JSON
 * shared the same lossy resolver and were not.
 *
 * The inconsistency was the real damage: a consumer had no rule for which
 * classes were trustworthy, so this pins BOTH directions —
 *
 *  - every coalesced class exports under its own name, by name, not by count;
 *  - selection is UNCHANGED. `--type IfcDoor` still returns the
 *    `IFCDOORSTANDARDCASE` line, and `EntityTable.getTypeName` still answers
 *    the coalesced family name — saved filters, the scope chips and
 *    `filter-evaluate.ts` all match on that answer.
 *
 * All four export paths are covered: CSV and JSON each build their rows one
 * way for the default columns and another way for custom (quantity/property)
 * columns, and the defect was in both.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { exactTypeName } from '@ifc-lite/data';
import { exportCommand } from './export.js';
import { createHeadlessContext } from '../loader.js';

/**
 * One STEP line per class under test. Written out rather than read from a
 * committed sample so the classes being asserted are visible beside the
 * assertions, and so this never depends on `pnpm fixtures`.
 */
const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('exact-type.ifc','2026-01-01T00:00:00',$,$,'ifc-lite','ifc-lite','Nobody');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0KhR8hr7H8eewFRKm6V1bJ',$,'Exact Type Project',$,$,$,$,(#14),#9);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#4=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#9=IFCUNITASSIGNMENT((#2,#3,#4));
#10=IFCCARTESIANPOINT((0.,0.,0.));
#11=IFCDIRECTION((0.,0.,1.));
#12=IFCDIRECTION((1.,0.,0.));
#13=IFCAXIS2PLACEMENT3D(#10,#11,#12);
#14=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#13,$);
#20=IFCLOCALPLACEMENT($,#13);
#30=IFCSITE('3WWqaXu9L0y8XqF6lHx6cU',$,'My Site',$,$,#20,$,$,.ELEMENT.,$,$,$,$,$);
#36=IFCBUILDING('3eJSUU$fr7WPzBLDr3NCgH',$,'My Building',$,$,#20,$,$,.ELEMENT.,$,$,$);
#42=IFCBUILDINGSTOREY('14hpMBCM10Oug9g6WpN$Er',$,'My Storey',$,$,#20,$,$,.ELEMENT.,0.);
#48=IFCRELAGGREGATES('3B4BOU0cfA28tnsk$BqNU5',$,$,$,#1,(#30));
#49=IFCRELAGGREGATES('3B4BOU0cfA28tnsk$BqNU6',$,$,$,#30,(#36));
#50=IFCRELAGGREGATES('3B4BOU0cfA28tnsk$BqNU7',$,$,$,#36,(#42));
#100=IFCWALLSTANDARDCASE('1WWqaXu9L0y8XqF6lHx601',$,'Wall SC',$,$,#20,$,$,$);
#101=IFCDOORSTANDARDCASE('1WWqaXu9L0y8XqF6lHx602',$,'Door SC',$,$,#20,$,$,$,$,$,$,$);
#102=IFCSLABSTANDARDCASE('1WWqaXu9L0y8XqF6lHx603',$,'Slab SC',$,$,#20,$,$,$);
#103=IFCDISTRIBUTIONFLOWELEMENT('1WWqaXu9L0y8XqF6lHx604',$,'Flow El',$,$,#20,$,$);
#104=IFCDISTRIBUTIONCONTROLELEMENT('1WWqaXu9L0y8XqF6lHx605',$,'Control El',$,$,#20,$,$);
#105=IFCWALL('1WWqaXu9L0y8XqF6lHx606',$,'Plain Wall',$,$,#20,$,$,$);
#106=IFCFICTIONALWIDGET('1WWqaXu9L0y8XqF6lHx607',$,'Not A Class',$,$,#20,$,$);
#110=IFCRELCONTAINEDINSPATIALSTRUCTURE('3B4BOU0cfA28tnsk$BqNU8',$,$,$,(#100,#101,#102,#103,#104,#105,#106),#42);
ENDSEC;
END-ISO-10303-21;
`;

/**
 * The required entities, by GlobalId — a NAMED list, not a row count, so a
 * regression that drops or renames one row fails on that row's name instead
 * of passing under a floor some other row happens to satisfy.
 */
const EXPECTED = new Map<string, string>([
  ['1WWqaXu9L0y8XqF6lHx601', 'IfcWallStandardCase'],
  ['1WWqaXu9L0y8XqF6lHx602', 'IfcDoorStandardCase'],
  ['1WWqaXu9L0y8XqF6lHx603', 'IfcSlabStandardCase'],
  ['1WWqaXu9L0y8XqF6lHx604', 'IfcDistributionFlowElement'],
  ['1WWqaXu9L0y8XqF6lHx605', 'IfcDistributionControlElement'],
  ['1WWqaXu9L0y8XqF6lHx606', 'IfcWall'],
]);

/** The class no IFC schema declares. Its GlobalId must never carry a name. */
const UNDECLARED_GLOBAL_ID = '1WWqaXu9L0y8XqF6lHx607';

const dir = mkdtempSync(join(tmpdir(), 'ifclite-export-exact-type-'));
const SRC = join(dir, 'exact-type.ifc');
writeFileSync(SRC, IFC);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
function outFile(ext: string): string {
  return join(dir, `out-${seq++}.${ext}`);
}

/** Parse a CSV export into GlobalId → Type. */
function csvTypes(text: string): Map<string, string> {
  const lines = text.split('\n').filter(Boolean);
  const header = lines[0].split(',');
  const typeCol = header.indexOf('Type');
  const idCol = header.indexOf('GlobalId');
  expect(typeCol).toBeGreaterThanOrEqual(0);
  expect(idCol).toBeGreaterThanOrEqual(0);
  const out = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    out.set(cells[idCol], cells[typeCol]);
  }
  return out;
}

/** Parse a JSON export into GlobalId → Type. */
function jsonTypes(text: string): Map<string, string> {
  const rows = JSON.parse(text) as Record<string, string>[];
  return new Map(rows.map((r) => [r.GlobalId, r.Type]));
}

/**
 * Every named entity must be present with its declared class — and the
 * anti-vacuity half: a shape that exported nothing, or that dropped the rows
 * being asserted, fails here rather than passing an empty forEach.
 */
function expectExactTypes(actual: Map<string, string>): void {
  for (const [globalId, expected] of EXPECTED) {
    expect(actual.get(globalId), `Type for ${globalId}`).toBe(expected);
  }
  expect(actual.size).toBeGreaterThanOrEqual(EXPECTED.size);
}

describe('CSV/JSON export names the declared IFC class', () => {
  it('CSV, default columns', async () => {
    const out = outFile('csv');
    await exportCommand([SRC, '--format', 'csv', '--out', out]);
    expectExactTypes(csvTypes(readFileSync(out, 'utf8')));
  });

  it('CSV, custom columns', async () => {
    const out = outFile('csv');
    await exportCommand([SRC, '--format', 'csv', '--columns', 'GlobalId,Type,Tag', '--out', out]);
    expectExactTypes(csvTypes(readFileSync(out, 'utf8')));
  });

  it('JSON, default columns', async () => {
    const out = outFile('json');
    await exportCommand([SRC, '--format', 'json', '--out', out]);
    expectExactTypes(jsonTypes(readFileSync(out, 'utf8')));
  });

  it('JSON, custom columns', async () => {
    const out = outFile('json');
    await exportCommand([SRC, '--format', 'json', '--columns', 'GlobalId,Type,Tag', '--out', out]);
    expectExactTypes(jsonTypes(readFileSync(out, 'utf8')));
  });

  it('a class no schema declares degrades to Unknown, and is not invented into a name', async () => {
    const { store } = await createHeadlessContext(SRC);
    expect(exactTypeName(store.entities, 106)).toBe('Unknown');

    const out = outFile('json');
    await exportCommand([SRC, '--format', 'json', '--out', out]);
    const text = readFileSync(out, 'utf8');
    expect(jsonTypes(text).has(UNDECLARED_GLOBAL_ID)).toBe(false);
    // Not merely absent as a row: the invented spellings must appear nowhere.
    expect(text).not.toContain('FictionalWidget');
    expect(text).not.toContain('FICTIONALWIDGET');
  });
});

describe('grouping is unchanged: --type still selects by the coalesced family', () => {
  it('--type IfcDoor still selects the IfcDoorStandardCase line, and prints its declared class', async () => {
    const out = outFile('json');
    await exportCommand([SRC, '--format', 'json', '--type', 'IfcDoor', '--out', out]);
    const types = jsonTypes(readFileSync(out, 'utf8'));
    expect([...types.keys()]).toEqual(['1WWqaXu9L0y8XqF6lHx602']);
    expect(types.get('1WWqaXu9L0y8XqF6lHx602')).toBe('IfcDoorStandardCase');
  });

  it('the declared class round-trips as a --type selector', async () => {
    const out = outFile('json');
    await exportCommand([SRC, '--format', 'json', '--type', 'IfcDistributionFlowElement', '--out', out]);
    const types = jsonTypes(readFileSync(out, 'utf8'));
    expect([...types.entries()]).toEqual([
      ['1WWqaXu9L0y8XqF6lHx604', 'IfcDistributionFlowElement'],
    ]);
  });

  it('the store still groups by the coalesced class', async () => {
    const { store } = await createHeadlessContext(SRC);
    // The seam this fix deliberately does NOT move: `getTypeName` is what
    // saved filters and the scope chips match on.
    expect(store.entities.getTypeName(101)).toBe('IfcDoor');
    expect(store.entities.getTypeName(103)).toBe('IfcDistributionElement');
    expect(store.entities.getTypeName(104)).toBe('IfcDistributionElement');
  });
});
