/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { IfcParser, EntityExtractor, extractStructuralOnDemand } from '@ifc-lite/parser';
import { StoreEditor, MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { createStructuralStoreBackend } from './store-structural-backend.js';
import { StoreNamespace } from './namespaces/store.js';
import type { BimBackend } from './types.js';
import type { StructuralStoreBackendMethods } from './store-structural-types.js';

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

  it('keeps a backend without the three new methods valid, and names the missing one', () => {
    // `satisfies` makes a rename fail here instead of turning the Omit below into a no-op.
    const added = ['addStructuralSurfaceMember', 'addStructuralCurveConnection', 'addStructuralSurfaceConnection'] as const satisfies readonly (keyof StructuralStoreBackendMethods)[];
    type New = (typeof added)[number];
    // Type-level: fails the typecheck lane if any of the three becomes required again.
    const legacy: StructuralStoreBackendMethods = {} as Omit<StructuralStoreBackendMethods, New>;
    const ns = new StoreNamespace({ store: legacy } as unknown as BimBackend);
    expect(() => ns.addStructuralSurfaceMember('m', 30, { Boundary: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] })).toThrow(/addStructuralSurfaceMember: not available/);
    expect(() => ns.addStructuralCurveConnection('m', 30, { Start: [0, 0, 0], End: [1, 0, 0] })).toThrow(/addStructuralCurveConnection: not available/);
    expect(() => ns.addStructuralSurfaceConnection('m', 30, { Boundary: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] })).toThrow(/addStructuralSurfaceConnection: not available/);
  });
});

// #9668: parameter extensions must reach the store through the real SDK namespace.
describe('R2 CREATE SDK variants (#9668)', () => {
  it.each(['IFC2X3', 'IFC4', 'IFC4X3'] as const)('%s forwards varying members, warping and eccentricity', async schema => {
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(MODEL.replace('IFC2X3', schema)).buffer, { disableWorkerScan: true });
    const view = new MutablePropertyView(null, 'm');
    const editor = new StoreEditor(store, view);
    const backend = { store: createStructuralStoreBackend(() => ({ store, editor, mutationView: view, modelId: 'm', ownerHistoryId: 4 })) } as unknown as BimBackend;
    const ns = new StoreNamespace(backend);
    const m = ns.addStructuralCurveMember('m', 30, { Type: 'IfcStructuralCurveMemberVarying', Start: [0,0,0], End: [2,0,0] });
    const c = ns.addStructuralPointConnection('m', 30, { Position: [0,0,0], BoundaryCondition: { WarpingStiffness: true } });
    const rel = ns.connectStructuralMemberToConnection('m', m.expressId, c.expressId, {
      AdditionalConditions: { Type: 'IfcSlippageConnectionCondition', SlippageX: 0.12 },
      ConnectionConstraint: { PointOnRelatingElement: [0,0,0], EccentricityInX: 0.1, EccentricityInY: 0, EccentricityInZ: 0 },
    });
    expect(editor.getEntityType(rel.expressId)).toBe('IfcRelConnectsWithEccentricity');
    const { content } = new StepExporter(store, view).export({ schema, applyMutations: true });
    const text = new TextDecoder().decode(content);
    expect(text).toContain('IFCSTRUCTURALCURVEMEMBERVARYING(');
    expect(text).toContain('IFCBOUNDARYNODECONDITIONWARPING(');
    expect(text).toContain("IFCSLIPPAGECONNECTIONCONDITION($,0.12,$,$)");
    if (schema !== 'IFC2X3') {
      const force = ns.addStructuralPointReaction('m', { AppliedLoad: { Type: 'IfcStructuralLoadSingleForceWarping', ForceZ: 2, WarpingMoment: 3 } });
      const forceLoad = editor.getNewEntity(force.expressId)!.attributes[7];
      const config = ns.addStructuralLoad('m', { Type: 'IfcStructuralLoadConfiguration', Values: [Number(String(forceLoad).slice(1)), Number(String(forceLoad).slice(1))], Locations: [[0], [1]] });
      const action = ns.addStructuralCurveAction('m', { AppliedLoad: config.expressId, PredefinedType: 'DISCRETE' });
      expect(editor.getNewEntity(action.expressId)!.attributes[7]).toBe(`#${config.expressId}`);
    }
  });
});


it('IFC2X3 SDK copies an imported thickness aspect without re-parenting its source (#9860)', async () => {
  const parse = (text: string) => new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
  const store = await parse(MODEL);
  const view = new MutablePropertyView(null, 'm');
  const editor = new StoreEditor(store, view);
  const api = (s: typeof store, e: StoreEditor, v: MutablePropertyView) => new StoreNamespace({ store: createStructuralStoreBackend(() => ({ store: s, editor: e, mutationView: v, modelId: 'm', ownerHistoryId: 4 })) } as unknown as BimBackend);
  const ns = api(store, editor, view);
  const Boundary: [number, number, number][] = [[0,0,0],[3,0,0],[0,3,0]];
  const base = ns.addStructuralSurfaceMember('m', 30, { Boundary, Thickness: 0.2 });
  const sourceShape = editor.getNewEntity(base.expressId)!.attributes[6];
  const representations = Boundary.map(position => {
    const point = editor.addEntity('IfcCartesianPoint', [position]).expressId;
    return `#${editor.addEntity('IfcShapeRepresentation', ['#7', 'Reference', 'Point', [`#${point}`]]).expressId}`;
  });
  const aspect = editor.addEntity('IfcShapeAspect', [representations, 'Thickness', null, true, sourceShape]).expressId;
  const text = new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC2X3', applyMutations: true }).content);
  const source = await parse(text);
  const nextView = new MutablePropertyView(null, 'm');
  const nextEditor = new StoreEditor(source, nextView);
  const varying = api(source, nextEditor, nextView).addStructuralSurfaceMember('m', 30, { Type: 'IfcStructuralSurfaceMemberVarying', Boundary, Thickness: 0.2, SubsequentThickness: [0.3, 0.4], VaryingThicknessLocation: aspect });
  const output = new TextDecoder().decode(new StepExporter(source, nextView).export({ schema: 'IFC2X3', applyMutations: true }).content);
  const parsed = await parse(output);
  const extractor = new EntityExtractor(parsed.source);
  const attrs = (id: number) => extractor.extractEntity(parsed.entityIndex.byId.get(id)!)!.attributes;
  const copyId = Number(attrs(varying.expressId)[10]);
  expect(copyId).not.toBe(aspect);
  expect(attrs(copyId)[4]).toBe(attrs(varying.expressId)[6]);
  expect(attrs(aspect)[4]).toBe(attrs(base.expressId)[6]);
});
