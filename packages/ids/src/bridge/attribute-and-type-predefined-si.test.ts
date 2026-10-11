/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS 1.0 compares every measure value in SI units (#7395, follow-ups):
 *   - an attribute whose declared EXPRESS type is a measure
 *     (`IfcDoor.OverallHeight`, an `IfcPositiveLengthMeasure`) is read in SI,
 *     not in the project's millimetres;
 *   - a predefined property set on a type object (`IfcDoorLiningProperties`
 *     in an `IfcDoorType`'s `HasPropertySets`) is inherited by the type's
 *     occurrences like an ordinary type property set, converted to SI.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS } from '../parser/xml-parser.js';
import { validateIDS } from '../validation/validator.js';
import { createDataAccessor } from './data-accessor.js';

// Millimetre project. #10 is a door typed by #20, whose HasPropertySets holds
// the predefined set 'TypeLining'. #11 is a door of the same type that also
// carries its own 'TypeLining' with a different LiningDepth.
const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('','2026-10-11T00:00:00',(),(),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('1hqIFTRjfV6AWq_bMtnZwI',$,$,$,$,$,$,$,#3);
#2=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#3=IFCUNITASSIGNMENT((#2));
#10=IFCDOOR('0Bd9sN2uK6fQ1oM5lR3zT0',$,'D1',$,$,$,$,$,2100.,900.,$,$,$);
#11=IFCDOOR('0Bd9sN2uK6fQ1oM5lR3zT1',$,'D2',$,$,$,$,$,2100.,900.,$,$,$);
#20=IFCDOORTYPE('2Yv7qL0sH4bN9mK3jP1xR8',$,'DT',$,$,(#21),$,$,$,.DOOR.,.SINGLE_SWING_LEFT.,$,$);
#21=IFCDOORLININGPROPERTIES('1Ce0tO3vL7gR2pN6mS4aU1',$,'TypeLining',$,100.,50.,$,$,$,$,$,$,$,$,$,$,$);
#22=IFCRELDEFINESBYTYPE('2Df1uP4wM8hS3qO7nT5bV2',$,$,$,(#10,#11),#20);
#30=IFCDOORLININGPROPERTIES('3Eg2vQ5xN9iT4rP8oU6cW3',$,'TypeLining',$,120.,$,$,$,$,$,$,$,$,$,$,$,$);
#31=IFCRELDEFINESBYPROPERTIES('4Fh3wR6yO0jU5sQ9pV7dX4',$,$,$,(#11),#30);
ENDSEC;
END-ISO-10303-21;
`;

async function accessor() {
  const bytes = new TextEncoder().encode(IFC);
  return createDataAccessor(await new IfcParser().parseColumnar(bytes.buffer.slice(0) as ArrayBuffer));
}

async function status(requirement: string) {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ids xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd" xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>SI</title></info>
  <specifications>
    <specification name="si" ifcVersion="IFC4">
      <applicability maxOccurs="unbounded">
        <entity><name><simpleValue>IFCDOOR</simpleValue></name></entity>
      </applicability>
      <requirements>${requirement}</requirements>
    </specification>
  </specifications>
</ids>
`;
  const report = await validateIDS(parseIDS(xml), await accessor(), {
    modelId: 'm1',
    schemaVersion: 'IFC4',
    entityCount: 5,
  });
  return report.specificationResults[0].status;
}

const attribute = (name: string, value: string) =>
  `<attribute><name><simpleValue>${name}</simpleValue></name><value><simpleValue>${value}</simpleValue></value></attribute>`;

describe('measure-typed attributes in SI (#7395)', () => {
  it('reads IfcDoor.OverallHeight and OverallWidth in metres', async () => {
    const a = await accessor();
    expect(a.getAttribute(10, 'OverallHeight')).toBeCloseTo(2.1, 12);
    expect(a.getAttribute(10, 'overallwidth')).toBeCloseTo(0.9, 12);
  });

  it('leaves a non-measure attribute as written', async () => {
    expect((await accessor()).getAttribute(10, 'Name')).toBe('D1');
  });

  it('passes "OverallHeight = 2.1" and fails "= 2100" end to end', async () => {
    expect(await status(attribute('OverallHeight', '2.1'))).toBe('pass');
    expect(await status(attribute('OverallHeight', '2100'))).toBe('fail');
  });
});

describe('predefined property sets on a type object (#7395)', () => {
  it('inherits the type IfcDoorLiningProperties on the occurrence, in metres', async () => {
    const lining = (await accessor()).getPropertySets(10).find((p) => p.name === 'TypeLining');
    expect(lining?.properties.find((p) => p.name === 'LiningDepth')?.value).toBeCloseTo(0.1, 12);
    expect(lining?.properties.find((p) => p.name === 'LiningThickness')?.value).toBeCloseTo(0.05, 12);
  });

  it("lets the occurrence's own predefined set win per property", async () => {
    const lining = (await accessor()).getPropertySets(11).find((p) => p.name === 'TypeLining');
    expect(lining?.properties.find((p) => p.name === 'LiningDepth')?.value).toBeCloseTo(0.12, 12);
    expect(lining?.properties.find((p) => p.name === 'LiningThickness')?.value).toBeCloseTo(0.05, 12);
  });
});
