/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { IfcParser, extractStructuralOnDemand } from '@ifc-lite/parser';
import { StoreEditor, MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { createStructuralStoreBackend } from './store-structural-backend.js';
import { StoreNamespace } from './namespaces/store.js';
import type { BimBackend } from './types.js';
const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',#4,'P',$,$,$,$,(#7),#9);
#2=IFCPERSON($,'Author',$,$,$,$,$,$);
#3=IFCORGANIZATION($,'Org',$,$,$);
#4=IFCOWNERHISTORY(#10,#11,$,.ADDED.,0,$,$,0);
#10=IFCPERSONANDORGANIZATION(#2,#3,$);
#11=IFCAPPLICATION(#3,'1','Test','Test');
#5=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCAXIS2PLACEMENT3D(#5,$,$);
#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#6,$);
#9=IFCUNITASSIGNMENT((#91));
#91=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCLOCALPLACEMENT($,#6);
#30=IFCBUILDINGSTOREY('0storey000000000000000',#4,'Level 0',$,$,#20,$,$,.ELEMENT.,0.);
#31=IFCRELAGGREGATES('0aggr00000000000000000',#4,$,$,#1,(#30));
ENDSEC;
END-ISO-10303-21;`;


describe('C2 SDK structural store authoring', () => {
  it.each(['IFC4', 'IFC4X3'])('%s forwards surface and connection builders into exported structural data', async schema => {
    const parser = new IfcParser();
    const parse = (text: string) => parser.parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
    const store = await parse(MODEL.replace('IFC2X3', schema));
    const view = new MutablePropertyView(null, 'm');
    const editor = new StoreEditor(store, view);
    const backend = { store: createStructuralStoreBackend(() => ({ store, editor, mutationView: view, modelId: 'm', ownerHistoryId: 4 })) } as unknown as BimBackend;
    const ns = new StoreNamespace(backend);
    const Boundary: [number, number, number][] = [[0,0,0],[4,0,0],[0,3,0]];
    const member = ns.addStructuralSurfaceMember('m', 30, { Boundary, Name: 'SDK plate', Thickness: 0.3 });
    const edge = ns.addStructuralCurveConnection('m', 30, { Start: [0,0,0], End: [4,0,0], Name: 'SDK edge' });
    const face = ns.addStructuralSurfaceConnection('m', 30, { Boundary, Name: 'SDK foundation', BoundaryCondition: { TranslationalStiffnessByAreaZ: true } });
    ns.connectStructuralMemberToConnection('m', member.expressId, edge.expressId);
    ns.connectStructuralMemberToConnection('m', member.expressId, face.expressId);
    const { content } = new StepExporter(store, view).export({ schema: schema as 'IFC4' | 'IFC4X3', applyMutations: true });
    const data = extractStructuralOnDemand(await parse(typeof content === 'string' ? content : new TextDecoder().decode(content)));
    expect(data.members[0]).toMatchObject({ name: 'SDK plate', thickness: 0.3 });
    expect(data.members[0].connectionGlobalIds).toEqual(data.connections.map(c => c.globalId));
    expect(data.connections.map(c => c.name)).toEqual(['SDK edge', 'SDK foundation']);
    expect(data.connections[1].appliedCondition?.components.TranslationalStiffnessByAreaZ).toBe(true);
  });
});
