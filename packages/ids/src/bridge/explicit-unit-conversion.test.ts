/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A property or quantity that declares its OWN `Unit` is in that unit, not in
 * the project's unit assignment, and IDS compares values in SI (#7395, case 1).
 * The parser already resolves the unit (`unitSiScale` on properties,
 * `explicitUnitSiScale` on quantities); the bridge must apply that scale
 * instead of the project factor.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS } from '../parser/xml-parser.js';
import { validateIDS } from '../validation/validator.js';
import { createDataAccessor } from './index.js';

// Metre project. #20..#23 carry their own millimetre / square-millimetre unit;
// #24 has a unit reference the parser cannot resolve; #25 is a plain project-unit length.
const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('','2026-10-11T00:00:00',(),(),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('1hqIFTRjfV6AWq_bMtnZwI',$,$,$,$,$,$,$,#6);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#4=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#6=IFCUNITASSIGNMENT((#2,#3,#4));
#7=IFCWALL('2nJrDaLQfJ1QPhdJR0o97J',$,$,$,$,$,$,$,$);
#9=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#10=IFCSIUNIT(*,.AREAUNIT.,.MILLI.,.SQUARE_METRE.);
#11=IFCPROPERTYSET('0aF8zX9mT1Hx2V3cP4kL5n',$,'Civil_Props',$,(#20,#21,#24,#25));
#12=IFCRELDEFINESBYPROPERTIES('1xdwj8qGXK4hzoNbvMdXJW',$,$,$,(#7),#11);
#13=IFCELEMENTQUANTITY('16MocU_IDOF8_x3Iqllz0d',$,'Qto_Civil',$,$,(#22,#23));
#14=IFCRELDEFINESBYPROPERTIES('3kQ1lW8vZ0Gm7N2bR5tY6u',$,$,$,(#7),#13);
#20=IFCPROPERTYSINGLEVALUE('Wall Thickness',$,IFCLENGTHMEASURE(100.),#9);
#21=IFCPROPERTYLISTVALUE('Offsets',$,(IFCLENGTHMEASURE(250.),IFCLENGTHMEASURE(500.)),#9);
#22=IFCQUANTITYLENGTH('Length',$,#9,2000.,$);
#23=IFCQUANTITYAREA('Area',$,#10,3000000.,$);
#24=IFCPROPERTYSINGLEVALUE('Odd',$,IFCLENGTHMEASURE(7.),#99);
#25=IFCPROPERTYSINGLEVALUE('Height',$,IFCLENGTHMEASURE(3.),$);
#30=IFCWALLTYPE('2Yv7qL0sH4bN9mK3jP1xR8',$,'T',$,$,(#31),$,$,$,.STANDARD.);
#31=IFCPROPERTYSET('3Zc8rM1tJ5dP0nL4kQ2yS9',$,'Type_Props',$,(#32));
#32=IFCPROPERTYSINGLEVALUE('Nominal Width',$,IFCLENGTHMEASURE(250.),#9);
#33=IFCRELDEFINESBYTYPE('0Bd9sN2uK6fQ1oM5lR3zT0',$,$,$,(#7),#30);
ENDSEC;
END-ISO-10303-21;
`;

function ids(pset: string, name: string, value: string, dataType = 'IFCLENGTHMEASURE'): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<ids xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd" xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>Own unit</title></info>
  <specifications>
    <specification name="own unit" ifcVersion="IFC4">
      <applicability maxOccurs="unbounded">
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property dataType="${dataType}">
          <propertySet><simpleValue>${pset}</simpleValue></propertySet>
          <baseName><simpleValue>${name}</simpleValue></baseName>
          <value><simpleValue>${value}</simpleValue></value>
        </property>
      </requirements>
    </specification>
  </specifications>
</ids>
`;
}

async function parseIfc(source: string) {
  const bytes = new TextEncoder().encode(source);
  return new IfcParser().parseColumnar(bytes.buffer.slice(0) as ArrayBuffer);
}

async function prop(pset: string, name: string) {
  const store = await parseIfc(IFC);
  return createDataAccessor(store)
    .getPropertySets(7)
    .find((p) => p.name === pset)
    ?.properties.find((p) => p.name === name);
}

async function status(idsXml: string) {
  const store = await parseIfc(IFC);
  const report = await validateIDS(parseIDS(idsXml), createDataAccessor(store), {
    modelId: 'm1',
    schemaVersion: 'IFC4',
    entityCount: 1,
  });
  return report.specificationResults[0].status;
}

describe('IDS bridge honours a property or quantity own Unit (#7395)', () => {
  it('converts a single value with its own millimetre unit to metres', async () => {
    expect((await prop('Civil_Props', 'Wall Thickness'))?.value).toBeCloseTo(0.1, 12);
  });

  it('converts list members with their own millimetre unit to metres', async () => {
    const values = (await prop('Civil_Props', 'Offsets'))?.values?.map(Number);
    expect(values?.[0]).toBeCloseTo(0.25, 12);
    expect(values?.[1]).toBeCloseTo(0.5, 12);
  });

  it('converts a quantity with its own millimetre unit to metres', async () => {
    expect((await prop('Qto_Civil', 'Length'))?.value).toBeCloseTo(2, 12);
  });

  it('converts a quantity with its own square-millimetre unit to square metres', async () => {
    expect((await prop('Qto_Civil', 'Area'))?.value).toBeCloseTo(3, 12);
  });

  it('converts a type-inherited property with its own millimetre unit to metres', async () => {
    expect((await prop('Type_Props', 'Nominal Width'))?.value).toBeCloseTo(0.25, 12);
  });

  it('leaves a value whose own unit cannot be resolved unscaled by the project factor', async () => {
    expect((await prop('Civil_Props', 'Odd'))?.value).toBe(7);
    // Same file in a millimetre project: the project factor must still not apply.
    const store = await parseIfc(IFC.replace("#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)", "#2=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)"));
    const odd = createDataAccessor(store)
      .getPropertySets(7)
      .find((p) => p.name === 'Civil_Props')
      ?.properties.find((p) => p.name === 'Odd');
    expect(odd?.value).toBe(7);
  });

  it('still applies the project unit when no own unit is declared', async () => {
    expect((await prop('Civil_Props', 'Height'))?.value).toBe(3);
  });

  it('passes "Wall Thickness = 0.1" and fails "= 100" end to end', async () => {
    expect(await status(ids('Civil_Props', 'Wall Thickness', '0.1'))).toBe('pass');
    expect(await status(ids('Civil_Props', 'Wall Thickness', '100'))).toBe('fail');
  });

  it('passes the quantity requirement in SI end to end', async () => {
    expect(await status(ids('Qto_Civil', 'Length', '2'))).toBe('pass');
    expect(await status(ids('Qto_Civil', 'Area', '3', 'IFCAREAMEASURE'))).toBe('pass');
  });
});
