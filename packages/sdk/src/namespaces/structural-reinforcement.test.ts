/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, expectTypeOf, it } from 'vitest';
import { IfcParser, extractStructuralOnDemand } from '@ifc-lite/parser';
import { StructuralNamespace } from './structural.js';
import type { BimBackend, StructuralExtractionData, StructuralLoadData } from '../types.js';

async function namespace(schema: string, configured: boolean) {
  const source = `ISO-10303-21;HEADER;
FILE_DESCRIPTION((''),'2;1');FILE_NAME('reinforcement.ifc','',(''),(''),'','','');
FILE_SCHEMA(('${schema}'));ENDSEC;DATA;
#15=IFCSURFACEREINFORCEMENTAREA('Reinforcement',(0.,0.002),(0.003,0.004,0.005),0.25);
${configured ? "#24=IFCSTRUCTURALLOADCONFIGURATION('Configuration',(#15),((4.)));\n#50=IFCSTRUCTURALSURFACEACTION('0KQ0efL39PrP5DeqBwaUNp',$,'Action',$,$,$,$,#24,.GLOBAL_COORDS.,.F.,$,.CONST.);" : ''}
ENDSEC;END-ISO-10303-21;`;
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer, { disableWorkerScan: true });
  const data: StructuralExtractionData = extractStructuralOnDemand(store);
  return new StructuralNamespace({ structural: { data: () => data } } as unknown as BimBackend);
}

for (const schema of ['IFC4', 'IFC4X3']) {
  it(`exposes the typed collection when standalone reinforcement is the only structural content in ${schema}`, async () => {
    const data = (await namespace(schema, false)).data();
    expectTypeOf(data.reinforcementAreas).toEqualTypeOf<StructuralLoadData[] | undefined>();
    expect(data.hasStructural).toBe(true);
    expect([data.analysisModels, data.members, data.connections, data.activities, data.loadGroups, data.resultGroups]).toEqual([[], [], [], [], [], []]);
    expect(data.reinforcementAreas?.[0].SurfaceReinforcement1).toEqual([0, 0.002]);
    expect(data.reinforcementAreas?.[0].SurfaceReinforcement2).toEqual([0.003, 0.004, 0.005]);
    expect(data.reinforcementAreas?.[0].components.ShearReinforcement).toBe(0.25);
  });

  it(`exposes typed reinforcement lists through configuration entries in ${schema}`, async () => {
    const data = (await namespace(schema, true)).data();
    const entry = data.activities[0].appliedLoad?.configuration?.entries[0];
    expectTypeOf(entry?.value?.SurfaceReinforcement1).toEqualTypeOf<number[] | undefined>();
    expect(entry?.value?.SurfaceReinforcement1).toEqual([0, 0.002]);
    expect(entry?.value?.SurfaceReinforcement2).toEqual([0.003, 0.004, 0.005]);
    expect(entry?.value).toEqual(data.reinforcementAreas?.[0]);
  });
}
