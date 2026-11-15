/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractStructuralOnDemand } from '@ifc-lite/parser';
import { parseStep } from '@/test/properties-panel-harness';
import { structuralCardSections } from './structural-card-model';

// #9949 item 1: an IFC2X3 varying action's SubsequentAppliedLoads are resolved by the read
// model and shown by the card with their values, not as bare `#id` references.
test('#9949 the card shows the values of an IFC2X3 varying action\'s subsequent loads', async () => {
  const store = await parseStep(`ISO-10303-21;HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('x.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC2X3'));ENDSEC;DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$,$,$);
#100=IFCSTRUCTURALLOADLINEARFORCE('F1',1.,2.,3.,4.,5.,6.);
#101=IFCSTRUCTURALLOADLINEARFORCE('F2',7.,8.,9.,10.,11.,12.);
#10=IFCSTRUCTURALLINEARACTIONVARYING('a1',$,$,$,$,$,$,#100,.LOCAL_COORDS.,.T.,$,.PROJECTED_LENGTH.,#201,(#101));
#201=IFCSHAPEASPECT((),$,$,.T.,$);
ENDSEC;END-ISO-10303-21;`);
  const data = extractStructuralOnDemand(store);
  assert.deepEqual(data.activities[0].subsequentLoads?.map((load) => load?.components.LinearForceX), [7]);
  const sections = structuralCardSections(data, { expressId: 10 }, 'IFC2X3');
  const subsequent = sections.find((section) => section.via === 'SubsequentLoads[0]');
  assert.ok(subsequent, 'the subsequent load has its own section');
  assert.deepEqual([subsequent.expressId, subsequent.type], [101, 'IfcStructuralLoadLinearForce']);
  assert.equal(subsequent.rows.find((row) => row.attribute === 'LinearForceX')?.value, 7);
});

// #9949 item 2: the connection relation and its constraint carry their EXPRESS type, so the card names them without inference.
test('#9949 the card names a member end and its eccentricity from the read model\'s own types', async () => {
  const store = await parseStep(`ISO-10303-21;HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('x.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
#10=IFCSTRUCTURALCURVEMEMBER('beam0000000000000000a',$,'M',$,$,$,$,.RIGID_JOINED_MEMBER.,$);
#20=IFCSTRUCTURALPOINTCONNECTION('conn000000000000000a',$,'C',$,$,$,$,$,$);
#60=IFCCONNECTIONPOINTECCENTRICITY($,$,1.25,0.,0.);
#41=IFCRELCONNECTSWITHECCENTRICITY('ecc00000000000000000a',$,$,$,#10,#20,$,$,$,$,#60);
ENDSEC;END-ISO-10303-21;`);
  const data = extractStructuralOnDemand(store);
  const relation = data.members[0].IfcRelConnectsStructuralMember?.[0];
  assert.equal(relation?.type, 'IfcRelConnectsWithEccentricity');
  assert.equal(relation?.ConnectionConstraint?.type, 'IfcConnectionPointEccentricity');
  const types = structuralCardSections(data, { expressId: 10 }, 'IFC4').map((section) => section.type);
  assert.ok(types.includes('IfcRelConnectsWithEccentricity') && types.includes('IfcConnectionPointEccentricity'), types.join());
});
