/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #9668: bim.store.planStructuralDerivation / deriveStructuralAnalysisModel.
import { describe, it, expect } from 'vitest';
import { IfcParser, extractStructuralOnDemand, structuralCounterparts } from '@ifc-lite/parser';
import { StoreEditor, MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { createStructuralDerivationStoreBackend } from './store-structural-derive.js';
import { StoreNamespace } from './namespaces/store.js';
import type { BimBackend } from './types.js';

/** One 3 m column, 0.3 m square, on a storey. */
const MODEL = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('t.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC2X3'));ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',#4,'P',$,$,$,$,(#7),#9);
#2=IFCPERSON($,'Author',$,$,$,$,$,$);
#3=IFCORGANIZATION($,'Org',$,$,$);
#4=IFCOWNERHISTORY(#10,#11,$,.NOCHANGE.,$,$,$,0);
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
#40=IFCLOCALPLACEMENT(#20,#6);
#41=IFCAXIS2PLACEMENT2D(#42,$);
#42=IFCCARTESIANPOINT((0.,0.));
#43=IFCRECTANGLEPROFILEDEF(.AREA.,$,#41,0.3,0.3);
#44=IFCDIRECTION((0.,0.,1.));
#45=IFCEXTRUDEDAREASOLID(#43,#6,#44,3.);
#46=IFCSHAPEREPRESENTATION(#7,'Body','SweptSolid',(#45));
#47=IFCPRODUCTDEFINITIONSHAPE($,$,(#46));
#50=IFCCOLUMN('0column0000000000000000',#4,'C1',$,$,#40,#47,$);
#51=IFCRELCONTAINEDINSPATIALSTRUCTURE('0contain00000000000000',#4,$,$,(#50),#30);
ENDSEC;
END-ISO-10303-21;`;

async function setup(schema: string) {
  const parse = (text: string) => new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
  const store = await parse(MODEL.replace('IFC2X3', schema));
  const view = new MutablePropertyView(null, 'm');
  const editor = new StoreEditor(store, view);
  const backend = { store: createStructuralDerivationStoreBackend(() => ({ store, editor, mutationView: view, modelId: 'm', ownerHistoryId: 4 })) } as unknown as BimBackend;
  const exportFile = async () => {
    const { content } = new StepExporter(store, view).export({ schema: schema as 'IFC2X3', applyMutations: true });
    return parse(typeof content === 'string' ? content : new TextDecoder().decode(content));
  };
  return { ns: new StoreNamespace(backend), exportFile };
}

describe('bim.store structural derivation (#9668)', () => {
  it('plans without writing, then derives a linked member, nodes and a guessed support (IFC2X3 included)', async () => {
    const { ns, exportFile } = await setup('IFC2X3');
    const plan = ns.planStructuralDerivation('m');
    expect(plan.report.counts).toMatchObject({ curveMembers: 1, nodes: 2, supports: 1, guessedSupports: 1 });
    expect(extractStructuralOnDemand(await exportFile()).hasStructural).toBe(false);

    const result = ns.deriveStructuralAnalysisModel('m', { supportType: 'fixed' });
    expect(result.analysisModel).toMatchObject({ modelId: 'm' });
    expect(result.report.counts.curveMembers).toBe(1);
    const written = await exportFile();
    const data = extractStructuralOnDemand(written);
    expect(data.members).toHaveLength(1);
    expect(structuralCounterparts(data, data.members[0].expressId)?.side).toBe('physical');
    expect(data.connections.find((c) => c.appliedCondition)?.appliedCondition?.components.RotationalStiffnessX).toBe(-1);
    expect(() => ns.deriveStructuralAnalysisModel('m')).toThrow(/no members/);
  });

  it('refuses IFC5, and names a backend without the capability', async () => {
    const { ns } = await setup('IFC5');
    expect(() => ns.planStructuralDerivation('m')).toThrow(/IFC5 is not supported/);
    const bare = new StoreNamespace({ store: {} } as unknown as BimBackend);
    expect(() => bare.planStructuralDerivation('m')).toThrow(/planStructuralDerivation: not available/);
    expect(() => bare.deriveStructuralAnalysisModel('m')).toThrow(/deriveStructuralAnalysisModel: not available/);
  });
});
