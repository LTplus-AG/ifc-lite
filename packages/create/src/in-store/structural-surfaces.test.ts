/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The structural builders write IFC2X3 records that survive a real STEP round trip.
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IfcParser, extractStructuralOnDemand, EntityExtractor } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import {
  addStructuralSurfaceMemberToStore, addStructuralCurveConnectionToStore, addStructuralSurfaceConnectionToStore,
  resolveSpatialAnchor, addStructuralAnalysisModelToStore, addStructuralPointActionToStore,
  connectStructuralMemberToConnectionInStore, connectStructuralActivityToItemInStore,
  assignToStructuralGroupInStore,
} from '../index.js';
import { linearProfileFrame } from './linear-profile-frame.js';
import type { SpatialAnchor } from './anchor.js';

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

async function parse(text: string) {
  return new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
}
async function fresh(schema = 'IFC2X3') {
  const store = await parse(MODEL.replace('IFC2X3', schema));
  const view = new MutablePropertyView(null, 'm');
  const editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, 30);
  let seed = 42;
  anchor.guidRandom = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const roundTrip = async () => {
    const { content } = new StepExporter(store, view).export({ schema: anchor.schema ?? 'IFC4', applyMutations: true });
    const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
    const parsed = await parse(text);
    const extractor = new EntityExtractor(parsed.source);
    const attrs = (id: number) => extractor.extractEntity(parsed.entityIndex.byId.get(id)!)!.attributes;
    return { text, data: extractStructuralOnDemand(parsed), attrs };
  };
  return { editor, anchor, roundTrip };
}

const Boundary: [number, number, number][] = [[0, 0, 0], [4, 0, 0], [4, 3, 0], [0, 3, 0]];
const fixed = ['IFCBOOLEAN', '.T.'];
const free = ['IFCBOOLEAN', '.F.'];

describe('C2 structural surface and connection builders', () => {
  it.each(['IFC2X3', 'IFC4', 'IFC4X3'])('%s surface member exports nine exact slots and planar face topology', async schema => {
    const { editor, anchor, roundTrip } = await fresh(schema);
    const r = addStructuralSurfaceMemberToStore(editor, anchor, { Boundary, Name: 'Plate', PredefinedType: 'SHELL', Thickness: 0.2, GlobalId: '0surface00000000000000' });
    const { attrs, data } = await roundTrip();
    expect(attrs(r.memberId)).toEqual(['0surface00000000000000', 4, 'Plate', null, null, r.placementId, r.productShapeId, '.SHELL.', 0.2]);
    expect(data.members[0]).toMatchObject({ type: 'IfcStructuralSurfaceMember', name: 'Plate', predefinedType: 'SHELL', thickness: 0.2 });
    expect(attrs(r.topologyRepId)).toEqual([anchor.bodyContextId, 'Reference', 'Face', [r.faceId]]);
    expect(attrs(r.faceId)).toEqual([[r.boundId], r.planeId, '.T.']);
    expect(attrs(r.boundId)).toEqual([r.loopId, '.T.']);
    expect(attrs(r.loopId)).toEqual([r.orientedEdgeIds]);
    r.orientedEdgeIds.forEach((id, i) => expect(attrs(id)).toEqual(['*', '*', r.edgeIds[i], '.T.']));
    r.edgeIds.forEach((id, i) => expect(attrs(id)).toEqual([r.vertexIds[i], r.vertexIds[(i + 1) % 4]]));
  });

  it.each(['IFC2X3', 'IFC4', 'IFC4X3'])('%s curve connection qualifies stiffness SELECTs and writes only the schema axis', async schema => {
    const { editor, anchor, roundTrip } = await fresh(schema);
    const r = addStructuralCurveConnectionToStore(editor, anchor, { Start: [0, 0, 0], End: [4, 0, 0], Name: 'Edge support', GlobalId: '0edge00000000000000000',
      ...(schema === 'IFC4' ? { Axis: [0, 1, 0] as [number, number, number] } : schema === 'IFC4X3' ? { AxisDirection: [0, 1, 0] as [number, number, number] } : {}),
      BoundaryCondition: { Name: 'Edge', TranslationalStiffnessByLengthX: true, TranslationalStiffnessByLengthY: false, TranslationalStiffnessByLengthZ: 12, RotationalStiffnessByLengthX: 6, RotationalStiffnessByLengthY: true, RotationalStiffnessByLengthZ: false } });
    const { attrs, data, text } = await roundTrip();
    expect(attrs(r.connectionId)).toEqual(['0edge00000000000000000', 4, 'Edge support', null, null, r.placementId, r.productShapeId, r.boundaryConditionId, ...(schema === 'IFC2X3' ? [] : [r.axisDirectionId])]);
    expect(attrs(r.boundaryConditionId!)).toEqual(schema === 'IFC2X3' ? ['Edge', -1, 0, 12, 6, -1, 0] : ['Edge', fixed, free, ['IFCMODULUSOFLINEARSUBGRADEREACTIONMEASURE', 12], ['IFCMODULUSOFROTATIONALSUBGRADEREACTIONMEASURE', 6], fixed, free]);
    const prefix = schema === 'IFC2X3' ? 'Linear' : 'Translational';
    expect(data.connections[0]).toMatchObject({ type: 'IfcStructuralCurveConnection', name: 'Edge support', appliedCondition: { name: 'Edge', components: {
      [`${prefix}StiffnessByLengthX`]: schema === 'IFC2X3' ? -1 : true, [`${prefix}StiffnessByLengthY`]: schema === 'IFC2X3' ? 0 : false, [`${prefix}StiffnessByLengthZ`]: 12,
      RotationalStiffnessByLengthX: 6, RotationalStiffnessByLengthY: schema === 'IFC2X3' ? -1 : true, RotationalStiffnessByLengthZ: schema === 'IFC2X3' ? 0 : false,
    } } });
    if (schema !== 'IFC2X3') expect(text).toContain('IFCBOOLEAN(.T.)');
    expect(attrs(r.edgeId)).toEqual([r.vertex1Id, r.vertex2Id]);
    if (schema !== 'IFC2X3') expect(attrs(r.axisDirectionId!)).toEqual([[1, 0, 0]]); // storey +Y is local X for an edge along storey +X
    expect(text.match(/IFCDIRECTION\(/g)?.length).toBe(schema === 'IFC2X3' ? 2 : 3); // IFC2X3: the placement's two axes, no unused connection axis
  });

  it.each(['IFC2X3', 'IFC4', 'IFC4X3'])('%s connected surfaces preserve membership and face stiffness', async schema => {
    const { editor, anchor, roundTrip } = await fresh(schema);
    const m = addStructuralSurfaceMemberToStore(editor, anchor, { Boundary, Name: 'Plate', PredefinedType: 'SHELL', Thickness: 0.2 });
    const edge = addStructuralCurveConnectionToStore(editor, anchor, { Start: [0, 0, 0], End: [4, 0, 0] });
    const r = addStructuralSurfaceConnectionToStore(editor, anchor, { Boundary, Name: 'Foundation', GlobalId: '0face00000000000000000', BoundaryCondition: { Name: 'Face', TranslationalStiffnessByAreaX: true, TranslationalStiffnessByAreaY: false, TranslationalStiffnessByAreaZ: 25 } });
    // Connected (every connection needs a member) but left out of the analysis model.
    const stray = addStructuralSurfaceConnectionToStore(editor, anchor, { Boundary, GlobalId: '0stray0000000000000000' });
    const { analysisModelId } = addStructuralAnalysisModelToStore(editor, anchor, {});
    const { activityId } = addStructuralPointActionToStore(editor, anchor, { ForceZ: -1, DestabilizingLoad: false });
    connectStructuralMemberToConnectionInStore(editor, anchor.ownerHistoryId, m.memberId, edge.connectionId, anchor.guidRandom);
    connectStructuralMemberToConnectionInStore(editor, anchor.ownerHistoryId, m.memberId, r.connectionId, anchor.guidRandom);
    connectStructuralMemberToConnectionInStore(editor, anchor.ownerHistoryId, m.memberId, stray.connectionId, anchor.guidRandom);
    connectStructuralActivityToItemInStore(editor, anchor.ownerHistoryId, m.memberId, activityId, anchor.guidRandom);
    assignToStructuralGroupInStore(editor, anchor.ownerHistoryId, analysisModelId, [m.memberId, edge.connectionId, r.connectionId], anchor.guidRandom);
    const { attrs, data, text } = await roundTrip();
    expect(attrs(r.connectionId)).toEqual(['0face00000000000000000', 4, 'Foundation', null, null, r.placementId, r.productShapeId, r.boundaryConditionId]);
    expect(attrs(r.boundaryConditionId!)).toEqual(schema === 'IFC2X3' ? ['Face', -1, 0, 25] : ['Face', fixed, free, ['IFCMODULUSOFSUBGRADEREACTIONMEASURE', 25]]);
    const prefix = schema === 'IFC2X3' ? 'Linear' : 'Translational';
    expect(data.connections[1]).toMatchObject({ type: 'IfcStructuralSurfaceConnection', name: 'Foundation', appliedCondition: { name: 'Face', components: { [`${prefix}StiffnessByAreaX`]: schema === 'IFC2X3' ? -1 : true, [`${prefix}StiffnessByAreaY`]: schema === 'IFC2X3' ? 0 : false, [`${prefix}StiffnessByAreaZ`]: 25 } } });
    expect(data.members[0].connectionGlobalIds).toEqual(data.connections.map(c => c.globalId));
    data.connections.forEach(c => expect(c.memberGlobalIds).toEqual([data.members[0].globalId]));
    expect(data.analysisModels[0].itemGlobalIds).toEqual([data.members[0].globalId, ...data.connections.slice(0, 2).map(c => c.globalId)]);
    expect(data.connections.map(c => c.globalId)).toContain('0stray0000000000000000');
    expect(data.analysisModels[0].itemGlobalIds).not.toContain('0stray0000000000000000');
    expect(data.activities[0].appliesToGlobalId).toBe(data.members[0].globalId);
    if (process.env.STRUCTURAL_EXPORT_DIR) writeFileSync(`${process.env.STRUCTURAL_EXPORT_DIR}/C2-${schema}.ifc`, text);
  });

  it.each([
    [[0, 0, 0], [1, 0, 0]],
    [[0, 0, 0], [1, 0, 0], [2, 0, 0]],
    [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 1]],
    [[0, 0, 0], [1, 0, 0], [1, 0, 0]],
    [[0, 0, 0], [4, 4, 0], [4, 0, 0], [0, 2, 0]], // bow-tie with non-zero net area
    [[0, 0, 0], [4, 0, 0], [4, 4, 0], [2, 0, 0], [0, 4, 0]], // vertex touching a non-adjacent edge
    [[0, 0, 0], [4, 0, 0], [4, 4, 0], [2, 1e-12, 0], [0, 4, 0]], // vertex within rounding of a non-adjacent edge
  ] satisfies [number, number, number][][])('rejects invalid surface boundaries before emitting entities: %j', async (...points) => {
    const { editor, anchor } = await fresh('IFC4');
    for (const build of [addStructuralSurfaceMemberToStore, addStructuralSurfaceConnectionToStore]) {
      expect(() => build(editor, anchor, { Boundary: points })).toThrow(/boundary|coplanar|degenerate/i);
      expect(editor.getMutationView().getNewEntities()).toHaveLength(0);
    }
  });
  it.each([
    ['counter-clockwise, reflex first corner', [[0, 0, 0], [2, 1, 0], [4, 0, 0], [4, 3, 0], [0, 3, 0]], [0, 0, 1]],
    ['clockwise rectangle', [[0, 0, 0], [0, 3, 0], [4, 3, 0], [4, 0, 0]], [0, 0, -1]],
  ] satisfies [string, [number, number, number][], number[]][])('plane normal follows the loop winding: %s', async (_label, points, normal) => {
    const { editor, anchor, roundTrip } = await fresh('IFC4');
    const r = addStructuralSurfaceMemberToStore(editor, anchor, { Boundary: points });
    const { attrs } = await roundTrip();
    expect((attrs(r.normalId)[0] as number[]).map(v => v + 0)).toEqual(normal);
  });
  it('defaults the curve connection axis off the edge and refuses one along it', async () => {
    const { editor, anchor, roundTrip } = await fresh('IFC4');
    const r = addStructuralCurveConnectionToStore(editor, anchor, { Start: [0, 0, 0], End: [0, 0, 3] });
    expect((await roundTrip()).attrs(r.axisDirectionId!)).toEqual([[0, 1, 0]]);
    expect(() => addStructuralCurveConnectionToStore(editor, anchor, { Start: [0, 0, 0], End: [4, 0, 0], Axis: [2, 0, 0] })).toThrow(/parallel to the edge/);
  });
  it('accepts collinear non-adjacent edges and float32 noise on a sloped plane', async () => {
    const { editor, anchor } = await fresh('IFC4');
    const notch: [number, number, number][] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [2, 1, 0], [2, 0, 0], [3, 0, 0], [3, 2, 0], [0, 2, 0]];
    expect(() => addStructuralSurfaceMemberToStore(editor, anchor, { Boundary: notch })).not.toThrow();
    // An irregular pentagon on z = 3 + 0.37x + 0.51y, rounded to float32 as a
    // viewer pick would be: about 3e-8 m off its plane.
    const roof = ([[0.31, 0.17], [9.73, 0.41], [11.29, 6.83], [4.07, 9.61], [-1.13, 5.27]] as [number, number][])
      .map(([x, y]) => [x, y, 3 + 0.37 * x + 0.51 * y].map(Math.fround) as [number, number, number]);
    expect(() => addStructuralSurfaceMemberToStore(editor, anchor, { Boundary: roof })).not.toThrow();
  });
  it('defaults the curve connection axis to storey up for any non-vertical slope', async () => {
    const { editor, anchor, roundTrip } = await fresh('IFC4');
    const ends: [number, number, number][] = [[4, 0, 0], [0.3, 0, 0.954], [1, 1, 3], [0, -2, 0.5]];
    const built = ends.map(End => addStructuralCurveConnectionToStore(editor, anchor, { Start: [0, 0, 0], End }));
    const { attrs } = await roundTrip();
    built.forEach((r, i) => {
      const { u, v, along } = linearProfileFrame([0, 0, 0], ends[i]);
      const [a, b, c] = attrs(r.axisDirectionId!)[0] as number[];
      const world = [0, 1, 2].map(k => a * u[k] + b * v[k] + c * along[k]);
      world.forEach((w, k) => expect(w).toBeCloseTo([0, 0, 1][k], 9));
    });
  });
  const tri: [number, number, number][] = [[0, 0, 0], [1, 0, 0], [1, 1, 0]];
  it.each([
    ['surface member, bad GlobalId', (e: StoreEditor, a: SpatialAnchor) => addStructuralSurfaceMemberToStore(e, a, { Boundary: tri, GlobalId: 'bad' }), /GlobalId/],
    ['surface connection, bad GlobalId', (e: StoreEditor, a: SpatialAnchor) => addStructuralSurfaceConnectionToStore(e, a, { Boundary: tri, GlobalId: 'bad' }), /GlobalId/],
    ['curve connection, bad GlobalId', (e: StoreEditor, a: SpatialAnchor) => addStructuralCurveConnectionToStore(e, a, { Start: [0, 0, 0], End: [1, 0, 0], GlobalId: 'bad' }), /GlobalId/],
    ['negative stiffness', (e: StoreEditor, a: SpatialAnchor) => addStructuralSurfaceConnectionToStore(e, a, { Boundary: tri, BoundaryCondition: { TranslationalStiffnessByAreaZ: -1 } }), /not negative/],
    ['closed ring', (e: StoreEditor, a: SpatialAnchor) => addStructuralSurfaceMemberToStore(e, a, { Boundary: [...tri, [0, 0, 0]] }), /do not repeat the first point/],
    ['missing boundary', (e: StoreEditor, a: SpatialAnchor) => addStructuralSurfaceMemberToStore(e, a, { Boundary: undefined as never }), /at least three finite boundary points/],
    ['string stiffness', (e: StoreEditor, a: SpatialAnchor) => addStructuralSurfaceConnectionToStore(e, a, { Boundary: tri, BoundaryCondition: { TranslationalStiffnessByAreaZ: '5' as never } }), /not negative/],
    ['axis almost along the edge', (e: StoreEditor, a: SpatialAnchor) => addStructuralCurveConnectionToStore(e, a, { Start: [0, 0, 0], End: [2, 0, 0], Axis: [1, 1e-8, 0] }), /parallel to the edge/],
    ['two-element axis', (e: StoreEditor, a: SpatialAnchor) => addStructuralCurveConnectionToStore(e, a, { Start: [0, 0, 0], End: [2, 0, 0], Axis: [0, 1] as never }), /Axis must be nonzero/],
  ] as const)('writes nothing when refused: %s', async (_label, build, message) => {
    const { editor, anchor } = await fresh('IFC4');
    expect(() => build(editor, anchor)).toThrow(message);
    expect(editor.getMutationView().getNewEntities()).toHaveLength(0);
  });
  it.each(['IFC2X3', 'IFC4'])('treats a null stiffness as unset: %s', async schema => {
    const { editor, anchor, roundTrip } = await fresh(schema);
    const r = addStructuralSurfaceConnectionToStore(editor, anchor, { Boundary: tri, BoundaryCondition: { TranslationalStiffnessByAreaX: null as never, TranslationalStiffnessByAreaZ: true } });
    expect((await roundTrip()).attrs(r.boundaryConditionId!)[1]).toBeNull();
  });
  it('refuses unsupported schema-specific axis attributes', async () => {
    const { editor, anchor } = await fresh();
    expect(() => addStructuralCurveConnectionToStore(editor, anchor, { Start: [0, 0, 0], End: [1, 0, 0], Axis: [0, 0, 1] })).toThrow(/IFC2X3/);
    expect(editor.getMutationView().getNewEntities()).toHaveLength(0);
  });
});
