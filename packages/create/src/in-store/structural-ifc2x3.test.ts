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
  resolveSpatialAnchor, addStructuralAnalysisModelToStore, addStructuralCurveMemberToStore,
  addStructuralPointConnectionToStore, addStructuralLoadGroupToStore,
  addStructuralPointActionToStore, addStructuralLinearActionToStore,
  connectStructuralMemberToConnectionInStore, connectStructuralActivityToItemInStore,
  assignToStructuralGroupInStore,
} from '../index.js';

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

describe('IFC2X3 structural builder STEP round trips', () => {
  it('analysis model preserves classification and load group references with nine slots', async () => {
    const { editor, anchor, roundTrip } = await fresh();
    const group = editor.addEntity('IfcStructuralLoadGroup', ['0group0000000000000000', '#4', 'G', null, null, '.LOAD_GROUP.', '.PERMANENT_G.', '.DEAD_LOAD_G.', 1, null]);
    const { analysisModelId } = addStructuralAnalysisModelToStore(editor, anchor, { Name: 'Analysis', PredefinedType: 'LOADING_3D', LoadGroupIds: [group.expressId] });
    const { data, attrs } = await roundTrip();
    expect(data.analysisModels[0]).toMatchObject({ name: 'Analysis', predefinedType: 'LOADING_3D', loadGroupGlobalIds: ['0group0000000000000000'] });
    expect(attrs(analysisModelId)).toHaveLength(9);
  });

  it('curve member omits Axis and preserves classification', async () => {
    const { editor, anchor, roundTrip } = await fresh();
    const { memberId } = addStructuralCurveMemberToStore(editor, anchor, { Start: [0, 0, 0], End: [4, 0, 0], Name: 'Beam', PredefinedType: 'RIGID_JOINED_MEMBER' });
    const { data, attrs } = await roundTrip();
    expect(data.members[0]).toMatchObject({ name: 'Beam', predefinedType: 'RIGID_JOINED_MEMBER' });
    expect(attrs(memberId)).toHaveLength(8);
  });

  it('point connection writes plain fixed/free stiffness measures and omits ConditionCoordinateSystem', async () => {
    const { editor, anchor, roundTrip } = await fresh();
    const { connectionId, boundaryConditionId } = addStructuralPointConnectionToStore(editor, anchor, { Position: [4, 0, 0], Name: 'Support', BoundaryCondition: { Name: 'Pinned', TranslationalStiffnessX: true, TranslationalStiffnessY: false, RotationalStiffnessZ: true } });
    const { data, attrs } = await roundTrip();
    expect(data.connections[0]).toMatchObject({ name: 'Support', appliedCondition: { name: 'Pinned', components: { LinearStiffnessX: -1, LinearStiffnessY: 0, RotationalStiffnessZ: -1 } } });
    expect(attrs(connectionId)).toHaveLength(8);
    expect(attrs(boundaryConditionId!)).toEqual(['Pinned', -1, 0, null, null, null, -1]);
  });

  it.each(['LOAD_GROUP', 'LOAD_CASE'] as const)('%s uses IfcStructuralLoadGroup and preserves values', async (PredefinedType) => {
    const { editor, anchor, roundTrip } = await fresh();
    const { loadGroupId } = addStructuralLoadGroupToStore(editor, anchor, { Name: 'Gravity', PredefinedType, ActionType: 'PERMANENT_G', ActionSource: 'DEAD_LOAD_G', Coefficient: 1.5, Purpose: 'Design' });
    const { data, attrs } = await roundTrip();
    expect(data.loadGroups[0]).toMatchObject({ type: 'IfcStructuralLoadGroup', name: 'Gravity', predefinedType: PredefinedType, actionType: 'PERMANENT_G', actionSource: 'DEAD_LOAD_G', coefficient: 1.5, purpose: 'Design' });
    expect(attrs(loadGroupId)).toHaveLength(10);
  });

  it('refuses only unsupported SelfWeightCoefficients before emitting entities', async () => {
    const { editor, anchor } = await fresh();
    expect(() => addStructuralLoadGroupToStore(editor, anchor, { ActionType: 'PERMANENT_G', ActionSource: 'DEAD_LOAD_G', SelfWeightCoefficients: [0, 0, -1] })).toThrow(/IFC2X3.*SelfWeightCoefficients/);
    expect(editor.getMutationView().getNewEntities()).toHaveLength(0);
  });

  it.each(['point', 'linear'] as const)('%s action preserves load components and required IFC2X3 slots', async (kind) => {
    const { editor, anchor, roundTrip } = await fresh();
    const { activityId } = kind === 'point'
      ? addStructuralPointActionToStore(editor, anchor, { Name: 'Load', ForceZ: -12, MomentX: 3, GlobalOrLocal: 'LOCAL_COORDS' })
      : addStructuralLinearActionToStore(editor, anchor, { Name: 'Load', LinearForceZ: -12, LinearMomentX: 3, GlobalOrLocal: 'LOCAL_COORDS' });
    const { data, attrs } = await roundTrip();
    expect(data.activities[0]).toMatchObject({ name: 'Load', globalOrLocal: 'LOCAL_COORDS', destabilizingLoad: false, appliedLoad: { components: kind === 'point' ? { ForceZ: -12, MomentX: 3 } : { LinearForceZ: -12, LinearMomentX: 3 } } });
    expect(attrs(activityId).slice(9)).toEqual(kind === 'point' ? ['.F.', null] : ['.F.', null, '.TRUE_LENGTH.']);
    // IFC2X3 slot 11 of a linear action is ProjectedOrTrue, not PredefinedType (IFC4's slot 11).
    if (kind === 'linear') expect(data.activities[0]).toMatchObject({ ProjectedOrTrue: 'TRUE_LENGTH', predefinedType: undefined });
  });

  it.each(['IFC2X3', 'IFC4', 'IFC4X3'])('%s connected model preserves all three relationship builders', async (schema) => {
    const { editor, anchor, roundTrip } = await fresh(schema);
    // Explicit distinct GUIDs also make compatibility record comparisons deterministic.
    const { memberId } = addStructuralCurveMemberToStore(editor, anchor, { Start: [0, 0, 0], End: [4, 0, 0], GlobalId: '0member000000000000000' });
    const { connectionId } = addStructuralPointConnectionToStore(editor, anchor, { Position: [4, 0, 0], BoundaryCondition: { TranslationalStiffnessX: true, RotationalStiffnessZ: false }, GlobalId: '0conn00000000000000000' });
    const { activityId } = addStructuralPointActionToStore(editor, anchor, { ForceZ: -12, DestabilizingLoad: true, GlobalId: '0action000000000000000' });
    const { activityId: linearId } = addStructuralLinearActionToStore(editor, anchor, { LinearForceZ: -5, GlobalId: '0linear000000000000000' });
    // Linked to a member but NOT assigned to the load group, so a reader that ignores group membership shows up.
    const strayGuid = '0stray0000000000000000';
    const { activityId: strayId } = addStructuralPointActionToStore(editor, anchor, { ForceX: 7, GlobalId: strayGuid });
    const { loadGroupId } = addStructuralLoadGroupToStore(editor, anchor, { PredefinedType: 'LOAD_CASE', ...(schema === 'IFC2X3' ? {} : { SelfWeightCoefficients: [0, 0, -1] as [number, number, number] }), ActionType: 'PERMANENT_G', ActionSource: 'DEAD_LOAD_G', GlobalId: '0group0000000000000000' });
    const { analysisModelId } = addStructuralAnalysisModelToStore(editor, anchor, { LoadGroupIds: [loadGroupId], GlobalId: '0model0000000000000000' });
    connectStructuralMemberToConnectionInStore(editor, anchor.ownerHistoryId, memberId, connectionId, anchor.guidRandom);
    connectStructuralActivityToItemInStore(editor, anchor.ownerHistoryId, connectionId, activityId, anchor.guidRandom);
    connectStructuralActivityToItemInStore(editor, anchor.ownerHistoryId, memberId, linearId, anchor.guidRandom);
    connectStructuralActivityToItemInStore(editor, anchor.ownerHistoryId, memberId, strayId, anchor.guidRandom);
    assignToStructuralGroupInStore(editor, anchor.ownerHistoryId, analysisModelId, [memberId, connectionId], anchor.guidRandom);
    assignToStructuralGroupInStore(editor, anchor.ownerHistoryId, loadGroupId, [activityId, linearId], anchor.guidRandom);
    const { data, text } = await roundTrip();
    expect(data.members[0].connectionGlobalIds).toEqual([data.connections[0].globalId]);
    expect(data.connections[0].memberGlobalIds).toEqual([data.members[0].globalId]);
    expect(data.activities.map(a => a.appliesToGlobalId)).toEqual([data.connections[0].globalId, data.members[0].globalId, data.members[0].globalId]);
    expect(data.analysisModels[0].itemGlobalIds).toEqual([data.members[0].globalId, data.connections[0].globalId]);
    expect(data.activities.map(a => a.globalId)).toContain(strayGuid);
    expect(data.loadGroups[0].activityGlobalIds).toEqual(['0action000000000000000', '0linear000000000000000']);
    expect(data.loadGroups[0].activityGlobalIds).not.toContain(strayGuid);
    expect(data.analysisModels[0].loadGroupGlobalIds).toEqual([data.loadGroups[0].globalId]);
    // Set STRUCTURAL_EXPORT_DIR to keep the files for an IfcOpenShell validation run.
    if (process.env.STRUCTURAL_EXPORT_DIR) writeFileSync(`${process.env.STRUCTURAL_EXPORT_DIR}/${schema}.ifc`, text);
  });
});

// #9668: SELECT stiffness members must retain their type through STEP export.
describe('point connection stiffness SELECT round trips', () => {
  it.each(['IFC4', 'IFC4X3'])('%s qualifies boolean and numeric stiffness', async (schema) => {
    const { editor, anchor, roundTrip } = await fresh(schema);
    const BoundaryCondition = {
      Name: 'Mixed', TranslationalStiffnessX: true, TranslationalStiffnessY: false,
      TranslationalStiffnessZ: 1000, RotationalStiffnessX: 2000,
      RotationalStiffnessY: true, RotationalStiffnessZ: false,
    };
    const { boundaryConditionId } = addStructuralPointConnectionToStore(editor, anchor, {
      Position: [4, 0, 0], BoundaryCondition,
    });
    const { text, data } = await roundTrip();
    expect(text).toContain(`#${boundaryConditionId}=IFCBOUNDARYNODECONDITION('Mixed',IFCBOOLEAN(.T.),IFCBOOLEAN(.F.),IFCLINEARSTIFFNESSMEASURE(1000.),IFCROTATIONALSTIFFNESSMEASURE(2000.),IFCBOOLEAN(.T.),IFCBOOLEAN(.F.));`);
    const { Name, ...components } = BoundaryCondition;
    expect(data.connections[0].appliedCondition).toMatchObject({ name: Name, components });
  });

  // A non-finite number is type-legal; IFC4 would export it as `$` and IFC2X3 would fail the whole export.
  it.each(['IFC2X3', 'IFC4', 'IFC4X3'])('%s refuses non-finite stiffness before emitting entities', async (schema) => {
    const { editor, anchor } = await fresh(schema);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => addStructuralPointConnectionToStore(editor, anchor, {
        Position: [4, 0, 0], BoundaryCondition: { TranslationalStiffnessX: true, RotationalStiffnessZ: value },
      })).toThrow(/finite/);
    }
    expect(editor.getMutationView().getNewEntities()).toHaveLength(0);
  });
});
