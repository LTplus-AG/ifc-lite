/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS 1.0 compares every measure value in SI units (#7395, part 2). Part 1
 * covered a value's own `Unit`; this pins the remaining gaps:
 *   - a type object's own `HasPropertySets` and the attributes of predefined
 *     property sets (`IfcDoorLiningProperties.LiningDepth`) take the project
 *     unit like any other property;
 *   - measure kinds beyond length/area/volume take their declared project
 *     unit: non-negative length, plane angle, temperature (with the Celsius
 *     offset), mass, time, force, power;
 *   - a list or table whose members carry different types converts each
 *     member by its own type, instead of adding a length-scaled copy of every
 *     number;
 *   - an overlay edit of a property with its own `Unit` is read back in that
 *     unit, not in the project's.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS } from '../parser/xml-parser.js';
import { validateIDS } from '../validation/validator.js';
import { createDataAccessor, type PropertyOverride } from './data-accessor.js';
import { propertyValueToRaw } from './index.js';

const DEG = 0.0174532925199433;

// Millimetre project with gram, degree, Celsius, minute, kilonewton and
// kilowatt units. #7 is a wall, #30 a wall type, #59 a door.
const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('','2026-10-11T00:00:00',(),(),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('1hqIFTRjfV6AWq_bMtnZwI',$,$,$,$,$,$,$,#6);
#2=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#3=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#4=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#5=IFCSIUNIT(*,.MASSUNIT.,$,.GRAM.);
#6=IFCUNITASSIGNMENT((#2,#3,#4,#5,#43,#44,#47,#49,#50));
#40=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);
#41=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#42=IFCMEASUREWITHUNIT(IFCPLANEANGLEMEASURE(${DEG}),#41);
#43=IFCCONVERSIONBASEDUNIT(#40,.PLANEANGLEUNIT.,'DEGREE',#42);
#44=IFCSIUNIT(*,.THERMODYNAMICTEMPERATUREUNIT.,$,.DEGREE_CELSIUS.);
#45=IFCSIUNIT(*,.TIMEUNIT.,$,.SECOND.);
#46=IFCMEASUREWITHUNIT(IFCTIMEMEASURE(60.),#45);
#47=IFCCONVERSIONBASEDUNIT(#48,.TIMEUNIT.,'MINUTE',#46);
#48=IFCDIMENSIONALEXPONENTS(0,0,1,0,0,0,0);
#49=IFCSIUNIT(*,.FORCEUNIT.,.KILO.,.NEWTON.);
#50=IFCSIUNIT(*,.POWERUNIT.,.KILO.,.WATT.);
#51=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCWALL('2nJrDaLQfJ1QPhdJR0o97J',$,$,$,$,$,$,$,$);
#11=IFCPROPERTYSET('0aF8zX9mT1Hx2V3cP4kL5n',$,'Kinds',$,(#20,#21,#22,#23,#24,#25,#26,#27,#28,#29));
#12=IFCRELDEFINESBYPROPERTIES('1xdwj8qGXK4hzoNbvMdXJW',$,$,$,(#7),#11);
#20=IFCPROPERTYSINGLEVALUE('Clearance',$,IFCNONNEGATIVELENGTHMEASURE(1500.),$);
#21=IFCPROPERTYSINGLEVALUE('Slope',$,IFCPLANEANGLEMEASURE(90.),$);
#22=IFCPROPERTYSINGLEVALUE('Temp',$,IFCTHERMODYNAMICTEMPERATUREMEASURE(20.),$);
#23=IFCPROPERTYSINGLEVALUE('Mass',$,IFCMASSMEASURE(2500.),$);
#24=IFCPROPERTYSINGLEVALUE('Duration',$,IFCTIMEMEASURE(2.),$);
#25=IFCPROPERTYSINGLEVALUE('Load',$,IFCFORCEMEASURE(3.),$);
#26=IFCPROPERTYSINGLEVALUE('Power',$,IFCPOWERMEASURE(1.5),$);
#27=IFCPROPERTYSINGLEVALUE('Ratio',$,IFCRATIOMEASURE(0.5),$);
#28=IFCPROPERTYSINGLEVALUE('Setpoint',$,IFCTHERMODYNAMICTEMPERATUREMEASURE(21.),#44);
#29=IFCPROPERTYSINGLEVALUE('Span',$,IFCLENGTHMEASURE(4.),#51);
#13=IFCPROPERTYSET('3kQ1lW8vZ0Gm7N2bR5tY6u',$,'Mixed',$,(#70,#71,#72));
#14=IFCRELDEFINESBYPROPERTIES('16MocU_IDOF8_x3Iqllz0d',$,$,$,(#7),#13);
#70=IFCPROPERTYTABLEVALUE('Curve',$,(IFCREAL(1000.),IFCLABEL('A')),(IFCLENGTHMEASURE(2000.),IFCPLANEANGLEMEASURE(90.)),$,$,$,$);
#71=IFCPROPERTYLISTVALUE('Offsets',$,(IFCLABEL('x'),IFCLENGTHMEASURE(500.)),$);
#72=IFCPROPERTYLISTVALUE('Masses',$,(IFCMASSMEASURE(2500.),IFCMASSMEASURE(4000.)),$);
#30=IFCWALLTYPE('2Yv7qL0sH4bN9mK3jP1xR8',$,'T',$,$,(#31),$,$,$,.STANDARD.);
#31=IFCPROPERTYSET('3Zc8rM1tJ5dP0nL4kQ2yS9',$,'Type_Props',$,(#32,#33));
#32=IFCPROPERTYSINGLEVALUE('Nominal Width',$,IFCLENGTHMEASURE(250.),$);
#33=IFCPROPERTYSINGLEVALUE('Weight',$,IFCMASSMEASURE(4000.),$);
#59=IFCDOOR('0Bd9sN2uK6fQ1oM5lR3zT0',$,$,$,$,$,$,$,$,$,$,$,$);
#60=IFCDOORLININGPROPERTIES('1Ce0tO3vL7gR2pN6mS4aU1',$,'Lining',$,100.,50.,$,$,$,$,$,$,$,$,$,$,$);
#61=IFCRELDEFINESBYPROPERTIES('2Df1uP4wM8hS3qO7nT5bV2',$,$,$,(#59),#60);
ENDSEC;
END-ISO-10303-21;
`;

async function parseIfc(source: string = IFC) {
  const bytes = new TextEncoder().encode(source);
  return new IfcParser().parseColumnar(bytes.buffer.slice(0) as ArrayBuffer);
}

async function prop(id: number, pset: string, name: string, overrides?: PropertyOverride[]) {
  const store = await parseIfc();
  return createDataAccessor(store, overrides ? (e) => (e === id ? overrides : undefined) : undefined)
    .getPropertySets(id)
    .find((p) => p.name === pset)
    ?.properties.find((p) => p.name === name);
}

function ids(entity: string, pset: string, name: string, value: string, dataType: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<ids xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd" xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>SI</title></info>
  <specifications>
    <specification name="si" ifcVersion="IFC4">
      <applicability maxOccurs="unbounded">
        <entity><name><simpleValue>${entity}</simpleValue></name></entity>
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

async function status(idsXml: string) {
  const store = await parseIfc();
  const report = await validateIDS(parseIDS(idsXml), createDataAccessor(store), {
    modelId: 'm1',
    schemaVersion: 'IFC4',
    entityCount: 3,
  });
  return report.specificationResults[0].status;
}

describe('type object own property sets and predefined property sets (#7395, case 2)', () => {
  it('converts a type object own HasPropertySets length to metres', async () => {
    expect((await prop(30, 'Type_Props', 'Nominal Width'))?.value).toBeCloseTo(0.25, 12);
  });

  it('converts a type object own HasPropertySets mass to kilograms', async () => {
    expect((await prop(30, 'Type_Props', 'Weight'))?.value).toBeCloseTo(4, 12);
  });

  it('converts IfcDoorLiningProperties.LiningDepth to metres', async () => {
    expect((await prop(59, 'Lining', 'LiningDepth'))?.value).toBeCloseTo(0.1, 12);
    expect((await prop(59, 'Lining', 'LiningThickness'))?.value).toBeCloseTo(0.05, 12);
  });

  it('passes "LiningDepth = 0.1" and fails "= 100" end to end', async () => {
    expect(await status(ids('IFCDOOR', 'Lining', 'LiningDepth', '0.1', 'IFCPOSITIVELENGTHMEASURE'))).toBe('pass');
    expect(await status(ids('IFCDOOR', 'Lining', 'LiningDepth', '100', 'IFCPOSITIVELENGTHMEASURE'))).toBe('fail');
  });
});

describe('measure kinds beyond length/area/volume (#7395, case 4)', () => {
  it('converts a non-negative length to metres', async () => {
    expect((await prop(7, 'Kinds', 'Clearance'))?.value).toBeCloseTo(1.5, 12);
  });

  it('converts a plane angle in degrees to radians', async () => {
    expect((await prop(7, 'Kinds', 'Slope'))?.value).toBeCloseTo(Math.PI / 2, 9);
  });

  it('converts a Celsius temperature to kelvin, offset included', async () => {
    expect((await prop(7, 'Kinds', 'Temp'))?.value).toBeCloseTo(293.15, 9);
  });

  it('converts a temperature with its own Celsius unit to kelvin', async () => {
    expect((await prop(7, 'Kinds', 'Setpoint'))?.value).toBeCloseTo(294.15, 9);
  });

  it('converts mass, time, force and power to kg, s, N and W', async () => {
    expect((await prop(7, 'Kinds', 'Mass'))?.value).toBeCloseTo(2.5, 12);
    expect((await prop(7, 'Kinds', 'Duration'))?.value).toBeCloseTo(120, 9);
    expect((await prop(7, 'Kinds', 'Load'))?.value).toBeCloseTo(3000, 9);
    expect((await prop(7, 'Kinds', 'Power'))?.value).toBeCloseTo(1500, 9);
  });

  it('leaves a dimensionless ratio as written', async () => {
    expect((await prop(7, 'Kinds', 'Ratio'))?.value).toBe(0.5);
  });

  it('passes SI literals and fails the as-written ones end to end', async () => {
    expect(await status(ids('IFCWALL', 'Kinds', 'Temp', '293.15', 'IFCTHERMODYNAMICTEMPERATUREMEASURE'))).toBe('pass');
    expect(await status(ids('IFCWALL', 'Kinds', 'Temp', '20', 'IFCTHERMODYNAMICTEMPERATUREMEASURE'))).toBe('fail');
    expect(await status(ids('IFCWALL', 'Kinds', 'Mass', '2.5', 'IFCMASSMEASURE'))).toBe('pass');
    expect(await status(ids('IFCWALL', 'Kinds', 'Mass', '2500', 'IFCMASSMEASURE'))).toBe('fail');
  });
});

describe('untyped list and table members (#7395, case 5)', () => {
  it('converts each table member by its own type and keeps no unscaled copies', async () => {
    const values = (await prop(7, 'Mixed', 'Curve'))?.values?.map(String);
    expect(values?.slice(0, 3)).toEqual(['1000', 'A', '2']);
    expect(Number(values?.[3])).toBeCloseTo(Math.PI / 2, 9);
    expect(values).toHaveLength(4);
  });

  it('converts the measure member of a mixed list and leaves the label', async () => {
    expect((await prop(7, 'Mixed', 'Offsets'))?.values).toEqual(['x', '0.5']);
  });

  it('keeps every member of a converted list in its display value', async () => {
    const masses = await prop(7, 'Mixed', 'Masses');
    expect(masses?.values?.map(Number)).toEqual([2.5, 4]);
    expect(masses?.value).toBe('2.5, 4');
  });

  it('does not match the raw millimetre value or a scaled IfcReal', async () => {
    expect(await status(ids('IFCWALL', 'Mixed', 'Curve', '2', 'IFCLENGTHMEASURE'))).toBe('pass');
    expect(await status(ids('IFCWALL', 'Mixed', 'Curve', '2000', 'IFCLENGTHMEASURE'))).toBe('fail');
    expect(await status(ids('IFCWALL', 'Mixed', 'Curve', '1', 'IFCLENGTHMEASURE'))).toBe('fail');
  });
});

describe('overlay edits of a property with its own Unit (#7395)', () => {
  it('reads an override back in the property own unit, not the project unit', async () => {
    const span = await prop(7, 'Kinds', 'Span', [{ psetName: 'Kinds', propName: 'Span', value: 5 }]);
    expect(span?.value).toBe(5);
  });

  it('keeps the own unit across two overrides of the same property', async () => {
    const span = await prop(7, 'Kinds', 'Span', [
      { psetName: 'Kinds', propName: 'Span', value: 4 },
      { psetName: 'Kinds', propName: 'Span', value: 5 },
    ]);
    expect(span?.value).toBe(5);
  });

  it('applies the Celsius offset to an override of a project-unit temperature', async () => {
    const temp = await prop(7, 'Kinds', 'Temp', [{ psetName: 'Kinds', propName: 'Temp', value: 25 }]);
    expect(temp?.value).toBeCloseTo(298.15, 9);
  });

  it('propertyValueToRaw inverts the same conversion for a correction write', async () => {
    const store = await parseIfc();
    expect(propertyValueToRaw(store, 7, 'Kinds', 'Span', 'IFCLENGTHMEASURE', 5)).toBe(5);
    expect(propertyValueToRaw(store, 7, 'Kinds', 'Clearance', 'IFCNONNEGATIVELENGTHMEASURE', 2)).toBeCloseTo(2000, 9);
    expect(propertyValueToRaw(store, 7, 'Kinds', 'Temp', 'IFCTHERMODYNAMICTEMPERATUREMEASURE', 298.15)).toBeCloseTo(25, 9);
    expect(propertyValueToRaw(store, 7, 'Kinds', 'Setpoint', 'IFCTHERMODYNAMICTEMPERATUREMEASURE', 294.15)).toBeCloseTo(21, 9);
    // A property the entity does not carry yet takes the project unit.
    expect(propertyValueToRaw(store, 7, 'Kinds', 'New', 'IFCLENGTHMEASURE', 1)).toBeCloseTo(1000, 9);
  });
});
