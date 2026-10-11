/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A temperature in an `IfcConversionBasedUnitWithOffset` (a degree
 * Fahrenheit over kelvin) is compared in kelvin, offset included (#7395):
 * 68 °F is 293.15 K, whether °F is the project's unit or the property's own.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { createDataAccessor } from './data-accessor.js';
import { propertyValueToRaw } from './index.js';

// `#44` is the project temperature unit: °F, or kelvin with `Own` in °F.
function ifc(projectTemperatureUnit: string): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('','2026-10-11T00:00:00',(),(),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('1hqIFTRjfV6AWq_bMtnZwI',$,$,$,$,$,$,$,#6);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#6=IFCUNITASSIGNMENT((#2,#${projectTemperatureUnit}));
#40=IFCDIMENSIONALEXPONENTS(0,0,0,0,1,0,0);
#41=IFCSIUNIT(*,.THERMODYNAMICTEMPERATUREUNIT.,$,.KELVIN.);
#42=IFCMEASUREWITHUNIT(IFCTHERMODYNAMICTEMPERATUREMEASURE(0.5555555555555556),#41);
#43=IFCCONVERSIONBASEDUNITWITHOFFSET(#40,.THERMODYNAMICTEMPERATUREUNIT.,'Fahrenheit',#42,-459.67);
#7=IFCWALL('2nJrDaLQfJ1QPhdJR0o97J',$,$,$,$,$,$,$,$);
#11=IFCPROPERTYSET('0aF8zX9mT1Hx2V3cP4kL5n',$,'Temps',$,(#20,#21));
#12=IFCRELDEFINESBYPROPERTIES('1xdwj8qGXK4hzoNbvMdXJW',$,$,$,(#7),#11);
#20=IFCPROPERTYSINGLEVALUE('Project',$,IFCTHERMODYNAMICTEMPERATUREMEASURE(68.),$);
#21=IFCPROPERTYSINGLEVALUE('Own',$,IFCTHERMODYNAMICTEMPERATUREMEASURE(68.),#43);
ENDSEC;
END-ISO-10303-21;
`;
}

function parse(projectTemperatureUnit: string) {
  const bytes = new TextEncoder().encode(ifc(projectTemperatureUnit));
  return new IfcParser().parseColumnar(bytes.buffer.slice(0) as ArrayBuffer);
}

async function value(projectTemperatureUnit: string, name: string) {
  const store = await parse(projectTemperatureUnit);
  return createDataAccessor(store).getPropertySets(7)
    .find((p) => p.name === 'Temps')
    ?.properties.find((p) => p.name === name)?.value;
}

describe('temperature in a unit with an offset (#7395)', () => {
  it('converts 68 in a Fahrenheit project unit to 293.15 K', async () => {
    expect(Number(await value('43', 'Project'))).toBeCloseTo(293.15, 9);
  });

  it('converts 68 in a property own Fahrenheit unit to 293.15 K', async () => {
    expect(Number(await value('41', 'Own'))).toBeCloseTo(293.15, 9);
    expect(Number(await value('41', 'Project'))).toBe(68);
  });

  it('inverts the offset for a correction write', async () => {
    const T = 'IFCTHERMODYNAMICTEMPERATUREMEASURE';
    expect(propertyValueToRaw(await parse('43'), 7, 'Temps', 'Project', T, 293.15)).toBeCloseTo(68, 9);
    expect(propertyValueToRaw(await parse('41'), 7, 'Temps', 'Own', T, 293.15)).toBeCloseTo(68, 9);
  });
});
