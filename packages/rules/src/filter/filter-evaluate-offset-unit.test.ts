/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A temperature in an `IfcConversionBasedUnitWithOffset` (°F over kelvin) has
 * no SI factor alone: `valueSiScales` is a multiplier, and multiplying 68 °F
 * by 5/9 gives 37.78, not 293.15 K. Such a value reports no SI factor, as an
 * unreadable unit does, whether °F is the project unit or the property's own,
 * read from the file or through the mutation overlay (#7395).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { IfcParser, extractPropertiesOnDemand, extractQuantitiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { readSubject } from './read-subject.js';

// `#30` assigns °F (#43) or kelvin (#41) as the project temperature unit.
function ifc(projectTemperatureUnit: string): string {
  return `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('t','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1= IFCPROJECT('0Proj000000000000000001',$,'P',$,$,$,$,$,#30);
#30= IFCUNITASSIGNMENT((#${projectTemperatureUnit}));
#40= IFCDIMENSIONALEXPONENTS(0,0,0,0,1,0,0);
#41= IFCSIUNIT(*,.THERMODYNAMICTEMPERATUREUNIT.,$,.KELVIN.);
#42= IFCMEASUREWITHUNIT(IFCTHERMODYNAMICTEMPERATUREMEASURE(0.5555555555555556),#41);
#43= IFCCONVERSIONBASEDUNITWITHOFFSET(#40,.THERMODYNAMICTEMPERATUREUNIT.,'Fahrenheit',#42,-459.67);
#101= IFCWALL('0WallA0000000000000001A',$,'Wall A',$,$,$,$,$,$);
#110= IFCPROPERTYSINGLEVALUE('Project',$,IFCTHERMODYNAMICTEMPERATUREMEASURE(68.),$);
#111= IFCPROPERTYSINGLEVALUE('Own',$,IFCTHERMODYNAMICTEMPERATUREMEASURE(68.),#43);
#112= IFCPROPERTYSET('0Pset00000000000000112A',$,'Temps',$,(#110,#111));
#113= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000113A',$,$,$,(#101),#112);
ENDSEC;
END-ISO-10303-21;
`;
}

async function parse(projectTemperatureUnit: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(ifc(projectTemperatureUnit));
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

async function siScales(projectTemperatureUnit: string, propertyName: string, overlay: boolean) {
  const store = await parse(projectTemperatureUnit);
  let mutationView: MutablePropertyView | undefined;
  if (overlay) {
    mutationView = new MutablePropertyView(null, 'm');
    mutationView.setOnDemandExtractor((id) => extractPropertiesOnDemand(store, id));
    mutationView.setQuantityExtractor((id) => extractQuantitiesOnDemand(store, id));
    // An edit elsewhere in the set makes the read go through the overlay.
    mutationView.setProperty(101, 'Temps', 'Note', 'edited');
  }
  const rule = { kind: 'property', setName: 'Temps', propertyName, op: 'isSet', value: '' } as const;
  return readSubject(rule, { store, expressId: 101, mutationView }).valueSiScales;
}

describe('a temperature in a unit with an offset has no SI factor (#7395)', () => {
  for (const overlay of [false, true]) {
    const via = overlay ? 'through the mutation overlay' : 'from the file';
    it(`in a Fahrenheit project unit, ${via}`, async () => {
      assert.deepEqual(await siScales('43', 'Project', overlay), [undefined]);
    });
    it(`in a property own Fahrenheit unit, ${via}`, async () => {
      assert.deepEqual(await siScales('41', 'Own', overlay), [undefined]);
      assert.deepEqual(await siScales('41', 'Project', overlay), [1]);
    });
  }
});
