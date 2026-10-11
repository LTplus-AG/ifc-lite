/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A property or quantity with its OWN `Unit` is in that unit, not in the
 * project's (#7395, part 1).
 *
 * IDS literals for IFC measures are in base SI. The parser already resolves
 * an explicit unit (`unitSiScale` on properties, `explicitUnitSiScale` on
 * quantities), but the IDS bridge dropped it and applied the project's
 * length/area/volume scale instead. In a metre project, a
 * `IFCLENGTHMEASURE(100.)` whose own unit is millimetres was compared as
 * 100 m, so a requirement of 0.1 failed. Civil 3D (IFC4X3) writes such
 * units.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS } from '../parser/xml-parser.js';
import { validateIDS } from '../validation/validator.js';
import { createDataAccessor } from './index.js';

function ifc(projectLengthUnit: string, data: string): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('','2026-10-11T00:00:00',(),(),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000001',$,'P',$,$,$,$,$,#3);
#2=${projectLengthUnit};
#3=IFCUNITASSIGNMENT((#2));
#4=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#5=IFCSIUNIT(*,.AREAUNIT.,.MILLI.,.SQUARE_METRE.);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCWALL('0000000000000000000020',$,'W-1',$,$,$,$,$,$);
${data}
ENDSEC;
END-ISO-10303-21;
`;
}

const METRE = 'IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)';
const MILLIMETRE = 'IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)';

// Thickness: own unit mm (#4). Height: no own unit. Width, Face: quantities
// with own units mm (#4) and mm² (#5). Length: quantity without own unit.
const PROPS_AND_QTYS = `#21=IFCPROPERTYSINGLEVALUE('Thickness',$,IFCLENGTHMEASURE(100.),#4);
#22=IFCPROPERTYSINGLEVALUE('Height',$,IFCLENGTHMEASURE(3.),$);
#23=IFCPROPERTYSET('0000000000000000000023',$,'Probe_Set',$,(#21,#22));
#24=IFCRELDEFINESBYPROPERTIES('0000000000000000000024',$,$,$,(#20),#23);
#30=IFCQUANTITYLENGTH('Width',$,#4,250.,$);
#31=IFCQUANTITYAREA('Face',$,#5,2000000.,$);
#32=IFCQUANTITYLENGTH('Length',$,$,4.,$);
#33=IFCELEMENTQUANTITY('0000000000000000000033',$,'Probe_Qto',$,$,(#30,#31,#32));
#34=IFCRELDEFINESBYPROPERTIES('0000000000000000000034',$,$,$,(#20),#33);`;

async function accessorFor(text: string) {
  const bytes = new TextEncoder().encode(text);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(0) as ArrayBuffer, { disableWorkerScan: true });
  return { store, accessor: createDataAccessor(store) };
}

describe('IDS bridge honours a value\'s own Unit (#7395)', () => {
  it('converts a property and quantities by their own unit in a metre project', async () => {
    const { accessor } = await accessorFor(ifc(METRE, PROPS_AND_QTYS));
    expect(accessor.getPropertyValue(20, 'Probe_Set', 'Thickness')?.value).toBeCloseTo(0.1, 12);
    expect(accessor.getPropertyValue(20, 'Probe_Qto', 'Width')?.value).toBeCloseTo(0.25, 12);
    expect(accessor.getPropertyValue(20, 'Probe_Qto', 'Face')?.value).toBeCloseTo(2, 12);
    // Without an own unit, the project's (metre) unit applies as before.
    expect(accessor.getPropertyValue(20, 'Probe_Set', 'Height')?.value).toBe(3);
    expect(accessor.getPropertyValue(20, 'Probe_Qto', 'Length')?.value).toBe(4);
  });

  it('uses the own unit instead of the project unit, never both', async () => {
    // A millimetre project, and a property whose own unit is metres (#6).
    const { accessor } = await accessorFor(ifc(MILLIMETRE, `#21=IFCPROPERTYSINGLEVALUE('Span',$,IFCLENGTHMEASURE(3.),#6);
#22=IFCPROPERTYSINGLEVALUE('Depth',$,IFCLENGTHMEASURE(450.),$);
#23=IFCPROPERTYSET('0000000000000000000023',$,'Probe_Set',$,(#21,#22));
#24=IFCRELDEFINESBYPROPERTIES('0000000000000000000024',$,$,$,(#20),#23);`));
    expect(accessor.getPropertyValue(20, 'Probe_Set', 'Span')?.value).toBe(3);
    expect(accessor.getPropertyValue(20, 'Probe_Set', 'Depth')?.value).toBeCloseTo(0.45, 12);
  });

  it('passes the issue reproduction end to end, from the IDS text', async () => {
    const { store, accessor } = await accessorFor(ifc(METRE, PROPS_AND_QTYS));
    const doc = parseIDS(`<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>own units</title></info>
  <specifications>
    <specification name="Thickness 0.1 m" ifcVersion="IFC4">
      <applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
      <requirements><property dataType="IFCLENGTHMEASURE"><propertySet><simpleValue>Probe_Set</simpleValue></propertySet><baseName><simpleValue>Thickness</simpleValue></baseName><value><simpleValue>0.1</simpleValue></value></property></requirements>
    </specification>
  </specifications>
</ids>`);
    const report = await validateIDS(doc, accessor, {
      modelId: 'm',
      schemaVersion: store.schemaVersion,
      entityCount: store.entityCount,
    }, { includePassingEntities: true });
    expect(report.specificationResults[0].entityResults.map((e) => [e.entityName, e.passed])).toEqual([['W-1', true]]);
  });
});
