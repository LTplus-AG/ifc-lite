/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { currentProjectUnitContext } from './current-project-unit-context.js';

const STEP = (unitsInContext: string) => `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0xScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,$,${unitsInContext});
#2=IFCUNITASSIGNMENT((#3));
#4=IFCUNITASSIGNMENT((#5));
#5=IFCCONVERSIONBASEDUNIT(#6,.LENGTHUNIT.,'FOOT',#7);
#6=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);
#7=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(304.8),#3);
#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
ENDSEC;
END-ISO-10303-21;
`;

async function parse(source: string) {
  const bytes = new TextEncoder().encode(source);
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

describe('project unit context with a mutation view (#11591)', () => {
  it('reports a project without UnitsInContext as available with SI defaults, like the source path', async () => {
    const store = await parse(STEP('$'));
    const withView = currentProjectUnitContext(store, new MutablePropertyView(store.properties, 'm'));
    const withoutView = currentProjectUnitContext(store, null);
    assert.equal(withView.status, 'available', String(withView.reason));
    assert.equal(withoutView.status, 'available');
    assert.equal(withView.value?.declaredCount, 0);
  });

  it('reads declared feet on both paths when UnitsInContext is set', async () => {
    const store = await parse(STEP('#4'));
    const context = currentProjectUnitContext(store, new MutablePropertyView(store.properties, 'm'));
    assert.equal(context.status, 'available');
    const foot = context.value?.unitForMeasure('IfcLengthMeasure');
    assert.equal(foot?.siScale, 0.3048);
    assert.deepEqual(foot, currentProjectUnitContext(store, null).value?.unitForMeasure('IfcLengthMeasure'));
  });

  for (const original of ['#2', '$']) it(`keeps an explicit clear unavailable when the saved slot was ${original} (#7357)`, async () => {
    const store = await parse(STEP(original));

    const view = new MutablePropertyView(store.properties, 'm');
    view.setPositionalAttribute(1, 8, '#2');
    view.setPositionalAttribute(1, 8, null);
    assert.equal(currentProjectUnitContext(store, view).status, 'unavailable');
  });
});
