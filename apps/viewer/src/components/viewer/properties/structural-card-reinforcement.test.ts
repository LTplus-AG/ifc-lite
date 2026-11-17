/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, extractStructuralOnDemand } from '@ifc-lite/parser';
import { structuralCardSections } from './structural-card-model.js';
import { structuralCardSubject, structuralRecord } from './selectedStructuralMember.js';

for (const schema of ['IFC4', 'IFC4X3']) {
  it(`shows standalone and configured reinforcement measures in ${schema}`, async () => {
    const text = `ISO-10303-21;HEADER;
FILE_DESCRIPTION((''),'2;1');FILE_NAME('reinforcement.ifc','',(''),(''),'','','');
FILE_SCHEMA(('${schema}'));ENDSEC;DATA;
#15=IFCSURFACEREINFORCEMENTAREA('Reinforcement',(0.,0.002),(0.003,0.004,0.005),0.25);
#24=IFCSTRUCTURALLOADCONFIGURATION('Configuration',(#15),((4.)));
#50=IFCSTRUCTURALSURFACEACTION('0KQ0efL39PrP5DeqBwaUNp',$,'Action',$,$,$,$,#24,.GLOBAL_COORDS.,.F.,$,.CONST.);
ENDSEC;END-ISO-10303-21;`;
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
    const data = extractStructuralOnDemand(store);
    const standalone = structuralCardSections(data, { expressId: 15 }, schema);
    assert.equal(standalone.length, 1);
    assert.equal(standalone[0].type, 'IfcSurfaceReinforcementArea');
    assert.equal(standalone[0].via, null);
    assert.deepEqual(standalone[0].rows, [
      { attribute: 'Name', value: 'Reinforcement' },
      { attribute: 'SurfaceReinforcement1', value: [0, 0.002], measure: 'IfcLengthMeasure' },
      { attribute: 'SurfaceReinforcement2', value: [0.003, 0.004, 0.005], measure: 'IfcLengthMeasure' },
      { attribute: 'ShearReinforcement', value: 0.25 },
    ]);
    const fromAction = structuralCardSections(data, { expressId: 50 }, schema).find(s => s.expressId === 15);
    assert.equal(fromAction?.via, 'Values[0]');
    assert.deepEqual(fromAction?.rows, standalone[0].rows);
    assert.equal(structuralCardSubject(data, 15, null)?.record?.info.expressId, 15);
    assert.equal(structuralRecord(data, null, 'Reinforcement'), null, 'resource Name must not become a GlobalId');
  });
}
