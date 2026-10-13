/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #ISSUE through a parsed model: a self-referencing `IfcDerivedUnit` (#50 ->
 * #51 -> #50) named as a property's and a quantity's own `Unit`, or listed in
 * the project's `IfcUnitAssignment`, made the public readers throw
 * `RangeError: Maximum call stack size exceeded` (and with them the IDS bridge
 * and rules, which read through them). Each reader now reports the unit the
 * way it reports any unit it cannot resolve, and every sound unit beside it
 * reads as before. `src/project-unit-walk.test.ts` covers the other shapes.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IfcParser, extractProjectUnits, extractPropertiesOnDemand, extractQuantitiesOnDemand } from '../src/index.js';

const gid = (n: number) => String(n).padStart(22, '0');
const LOOP = ["#50=IFCDERIVEDUNIT((#51),.USERDEFINED.,'loop');", '#51=IFCDERIVEDUNITELEMENT(#50,1);'];

/** Wall #10 with `Looped` (own Unit `unit`), `Milli` (own Unit mm) and `Plain`, and quantity `Len` (own Unit `unit`). */
function model(assignment: string, unit: string): ArrayBuffer {
  const text = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    "FILE_NAME('unit-walk.ifc','2026-10-13T00:00:00',(''),(''),'','','');", "FILE_SCHEMA(('IFC4X3_ADD2'));", 'ENDSEC;', 'DATA;',
    `#1=IFCPROJECT('${gid(1)}',$,'P',$,$,$,$,$,#3);`,
    '#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
    `#3=IFCUNITASSIGNMENT((${assignment}));`,
    '#4=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);',
    `#10=IFCWALL('${gid(10)}',$,'W',$,$,$,$,$,$);`,
    ...LOOP,
    `#35=IFCPROPERTYSINGLEVALUE('Looped',$,IFCLENGTHMEASURE(2.5),${unit});`,
    "#36=IFCPROPERTYSINGLEVALUE('Milli',$,IFCLENGTHMEASURE(2500.),#4);",
    "#37=IFCPROPERTYSINGLEVALUE('Plain',$,IFCLENGTHMEASURE(2.5),$);",
    `#40=IFCPROPERTYSET('${gid(40)}',$,'Probe_Set',$,(#35,#36,#37));`,
    `#41=IFCRELDEFINESBYPROPERTIES('${gid(41)}',$,$,$,(#10),#40);`,
    `#45=IFCQUANTITYLENGTH('Len',$,${unit},2.5,$);`,
    "#44=IFCQUANTITYLENGTH('MilliLen',$,#4,2500.,$);",
    `#46=IFCELEMENTQUANTITY('${gid(46)}',$,'Qto_Probe',$,$,(#45,#44));`,
    `#47=IFCRELDEFINESBYPROPERTIES('${gid(47)}',$,$,$,(#10),#46);`,
    'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n');
  const bytes = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

const parse = (assignment: string, unit: string) =>
  new IfcParser().parseColumnar(model(assignment, unit), { disableWorkerScan: true });

describe('a self-referencing derived unit in a parsed model (#ISSUE)', () => {
  it('as a property own Unit: reported unresolved, the other properties read as before', async () => {
    const store = await parse('#2', '#50');
    const set = extractPropertiesOnDemand(store, 10).find((s) => s.name === 'Probe_Set');
    const byName = new Map(set?.properties.map((p) => [p.name, p]));
    // The STEP reference with no scale, as for any Unit this reader cannot resolve (#4833).
    expect(byName.get('Looped')).toMatchObject({ value: 2.5, unit: '#50' });
    expect(byName.get('Looped')?.unitSiScale).toBeUndefined();
    expect(byName.get('Milli')).toMatchObject({ value: 2500, unit: 'mm', unitSiScale: 0.001 });
    expect(byName.get('Plain')?.unit).toBeUndefined();
  });

  it('as a quantity own Unit: marked unresolved, never the project scale', async () => {
    const store = await parse('#2', '#50');
    const set = extractQuantitiesOnDemand(store, 10).find((s) => s.name === 'Qto_Probe');
    const byName = new Map(set?.quantities.map((q) => [q.name, q]));
    expect(byName.get('Len')).toMatchObject({ value: 2.5, explicitUnitUnresolved: true });
    expect(byName.get('Len')?.explicitUnitSiScale).toBeUndefined();
    expect(byName.get('MilliLen')).toMatchObject({ value: 2500, explicitUnit: 'mm', explicitUnitSiScale: 0.001 });
  });

  it('in the project unit assignment: skipped, and the declared metre still resolves', async () => {
    const store = await parse('#2,#50', '$');
    const units = extractProjectUnits(store.source, store.entityIndex);
    expect(units.resolvedForUnitType('LENGTHUNIT')).toEqual({ symbol: 'm', siScale: 1 });
    expect(units.resolvedForUnitType('USERDEFINED')).toBeUndefined();
    expect(units.declaredCount).toBe(1);
  });
});

// A committed exporter file whose IfcUnitAssignment lists 25 units, nine of them
// IfcDerivedUnits of up to four elements: the bound must not bind on real output.
const EXPORTER_FILE = fileURLToPath(new URL('../../../rust/geometry/tests/fixtures/issue_098_wall_V5C.ifc', import.meta.url));

// Committed, so a missing file fails here rather than skipping the control.
describe('derived units from a real exporter stay inside the bound (#ISSUE)', () => {
  it('every derived unit in the assignment resolves', async () => {
    const bytes = readFileSync(EXPORTER_FILE);
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const store = await new IfcParser().parseColumnar(buffer, { disableWorkerScan: true });
    const units = extractProjectUnits(store.source, store.entityIndex);
    // 25 members, two of them USERDEFINED: the first of a unit type is kept.
    expect(units.declaredCount).toBe(24);
    // Each derived unit resolves to its SI scale; the composed symbol text is
    // not this bound's business, so it is not pinned here.
    for (const unitType of [
      'MASSDENSITYUNIT', 'MOMENTOFINERTIAUNIT', 'THERMALTRANSMITTANCEUNIT', 'VOLUMETRICFLOWRATEUNIT',
      'USERDEFINED', 'LINEARVELOCITYUNIT', 'LINEARFORCEUNIT', 'PLANARFORCEUNIT',
    ]) {
      const resolved = units.resolvedForUnitType(unitType);
      expect(resolved?.symbol, unitType).toBeTruthy();
      expect(resolved?.siScale, unitType).toBe(1);
    }
  });
});
