/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The structural builders write IFC2X3 records that survive a real STEP round trip.
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IfcParser, extractStructuralOnDemand, EntityExtractor } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { resolveSpatialAnchor, addStructuralLoadGroupToStore, addStructuralCurveMemberToStore, connectStructuralMemberToConnectionInStore, addStructuralPointActionToStore, addStructuralPointConnectionToStore, connectStructuralActivityToItemInStore, assignToStructuralGroupInStore } from '../index.js';
import { addStructuralPlanarActionToStore, addStructuralSurfaceActionToStore } from './structural-surface-action.js';
import { addStructuralPointReactionToStore, addStructuralCurveReactionToStore, addStructuralSurfaceReactionToStore } from './structural-reaction.js';
import { addStructuralResultGroupToStore } from './structural-result-group.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

let exportIndex = 0;
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
    const dir = mkdtempSync(join(tmpdir(), 'structural-c3-'));
    let parsed;
    try {
      const file = join(dir, 'results.ifc');
      writeFileSync(file, text);
      parsed = await parse(readFileSync(file, 'utf8'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
    if (process.env.STRUCTURAL_EXPORT_DIR) writeFileSync(`${process.env.STRUCTURAL_EXPORT_DIR}/${schema}-c3-${exportIndex++}.ifc`, text);
    const extractor = new EntityExtractor(parsed.source);
    const attrs = (id: number) => extractor.extractEntity(parsed.entityIndex.byId.get(id)!)!.attributes;
    return { text, data: extractStructuralOnDemand(parsed), attrs };
  };
  return { editor, anchor, roundTrip };
}

// #9668: constant activities and assigned results survive file export and structural extraction.
describe.each(['IFC2X3', 'IFC4', 'IFC4X3'])('%s activity and result builders', schema => {
  it('preserves planar force and temperature actions in their schema slots', async () => {
    const { editor, anchor, roundTrip } = await fresh(schema);
    const force = addStructuralPlanarActionToStore(editor, anchor, {
      Name: 'Pressure', AppliedLoad: { Type: 'IfcStructuralLoadPlanarForce', PlanarForceZ: -4 },
      GlobalOrLocal: 'LOCAL_COORDS', DestabilizingLoad: true,
    });
    const thermal = addStructuralPlanarActionToStore(editor, anchor, {
      Name: 'Thermal', AppliedLoad: { Type: 'IfcStructuralLoadTemperature', DeltaTConstant: 12, DeltaTY: 2, DeltaTZ: -3 },
    });
    if (schema !== 'IFC2X3') addStructuralSurfaceActionToStore(editor, anchor, {
      Name: 'Surface', AppliedLoad: { Type: 'IfcStructuralLoadPlanarForce', PlanarForceX: 0 },
      ProjectedOrTrue: 'PROJECTED_LENGTH',
    });
    const connection = addStructuralPointConnectionToStore(editor, anchor, { Position: [0, 0, 0] });
    const member = addStructuralCurveMemberToStore(editor, anchor, { Start: [0, 0, 0], End: [1, 0, 0] });
    connectStructuralMemberToConnectionInStore(editor, anchor.ownerHistoryId, member.memberId, connection.connectionId);
    const activities = editor.getMutationView().getNewEntities().filter(e => e.type.endsWith('Action'));
    for (const a of activities) connectStructuralActivityToItemInStore(editor, anchor.ownerHistoryId, connection.connectionId, a.expressId);
    const { data, attrs } = await roundTrip();
    expect(data.activities.find(a => a.expressId === force.activityId)).toMatchObject({
      name: 'Pressure', globalOrLocal: 'LOCAL_COORDS', destabilizingLoad: true,
      ProjectedOrTrue: 'TRUE_LENGTH', appliedLoad: { components: { PlanarForceZ: -4 } },
    });
    expect(data.activities.find(a => a.expressId === thermal.activityId)?.appliedLoad?.components).toEqual(
      schema === 'IFC2X3' ? { DeltaT_Constant: 12, DeltaT_Y: 2, DeltaT_Z: -3 } : { DeltaTConstant: 12, DeltaTY: 2, DeltaTZ: -3 });
    expect(attrs(force.activityId).slice(9)).toEqual(schema === 'IFC2X3' ? ['.T.', null, '.TRUE_LENGTH.'] : ['.T.', '.TRUE_LENGTH.', '.CONST.']);
    if (schema !== 'IFC2X3') expect(data.activities.find(a => a.name === 'Surface')).toMatchObject({
      type: 'IfcStructuralSurfaceAction', ProjectedOrTrue: 'PROJECTED_LENGTH', predefinedType: 'CONST', appliedLoad: { components: { PlanarForceX: 0 } },
    });
  });

  it('assigns reactions to a result group for the specified load group', async () => {
    const { editor, anchor, roundTrip } = await fresh(schema);
    const force = addStructuralPointReactionToStore(editor, anchor, { AppliedLoad: { Type: 'IfcStructuralLoadSingleForce', ForceZ: 10, MomentX: 2 } });
    const displacement = addStructuralPointReactionToStore(editor, anchor, { GlobalOrLocal: 'LOCAL_COORDS', AppliedLoad: { Type: 'IfcStructuralLoadSingleDisplacement', DisplacementX: 0.02, RotationalDisplacementRZ: -0.1 } });
    const reactions = [force, displacement];
    if (schema !== 'IFC2X3') {
      reactions.push(addStructuralCurveReactionToStore(editor, anchor, { AppliedLoad: { LinearForceY: 7, LinearMomentZ: -2 } }));
      reactions.push(addStructuralSurfaceReactionToStore(editor, anchor, { AppliedLoad: { PlanarForceZ: 3 } }));
    }
    const { loadGroupId } = addStructuralLoadGroupToStore(editor, anchor, { ActionType: 'PERMANENT_G', ActionSource: 'DEAD_LOAD_G' });
    const { resultGroupId } = addStructuralResultGroupToStore(editor, anchor, {
      Name: 'Results', TheoryType: 'SECOND_ORDER_THEORY', ResultForLoadGroup: loadGroupId,
      IsLinear: false, ReactionIds: reactions.map(r => r.activityId),
    });
    const input = addStructuralPointActionToStore(editor, anchor, { ForceZ: -10 });
    assignToStructuralGroupInStore(editor, anchor.ownerHistoryId, loadGroupId, [input.activityId]);
    const connection = addStructuralPointConnectionToStore(editor, anchor, { Position: [0, 0, 0] });
    const member = addStructuralCurveMemberToStore(editor, anchor, { Start: [0, 0, 0], End: [1, 0, 0] });
    connectStructuralMemberToConnectionInStore(editor, anchor.ownerHistoryId, member.memberId, connection.connectionId);
    for (const a of [...reactions, input]) connectStructuralActivityToItemInStore(editor, anchor.ownerHistoryId, connection.connectionId, a.activityId);
    const { data } = await roundTrip();
    const results = data.activities.filter(a => a.type.endsWith('Reaction'));
    expect(results.map(a => a.appliedLoad?.components)).toEqual([
      { ForceZ: 10, MomentX: 2 }, { DisplacementX: 0.02, RotationalDisplacementRZ: -0.1 },
      ...(schema === 'IFC2X3' ? [] : [{ LinearForceY: 7, LinearMomentZ: -2 }, { PlanarForceZ: 3 }]),
    ]);
    expect(data.resultGroups[0]).toMatchObject({ expressId: resultGroupId, theoryType: 'SECOND_ORDER_THEORY', isLinear: false,
      resultForLoadGroupGlobalId: data.loadGroups[0].globalId, activityGlobalIds: results.map(a => a.globalId) });
  });

  it('refuses empty, non-finite and invalid projected loads without partial writes', async () => {
    const { editor, anchor } = await fresh(schema);
    for (const PlanarForceZ of [undefined, NaN, Infinity]) {
      expect(() => addStructuralPlanarActionToStore(editor, anchor, { AppliedLoad: { Type: 'IfcStructuralLoadPlanarForce', PlanarForceZ } })).toThrow();
    }
    expect(() => addStructuralPlanarActionToStore(editor, anchor, { AppliedLoad: { Type: 'IfcStructuralLoadPlanarForce', PlanarForceX: 1 }, ProjectedOrTrue: 'PROJECTED_LENGTH', GlobalOrLocal: 'LOCAL_COORDS' })).toThrow(/GLOBAL_COORDS/);
    expect(() => addStructuralPointReactionToStore(editor, anchor, { AppliedLoad: { Type: 'IfcStructuralLoadSingleDisplacement', DisplacementX: NaN } })).toThrow(/finite/);
    expect(() => addStructuralResultGroupToStore(editor, anchor, { TheoryType: 'FIRST_ORDER_THEORY', ResultForLoadGroup: 1, IsLinear: true, ReactionIds: [30] })).toThrow(/load group/);
    if (schema === 'IFC2X3') {
      expect(() => addStructuralCurveReactionToStore(editor, anchor, { AppliedLoad: { LinearForceX: 1 } })).toThrow(/IFC2X3/);
      expect(() => addStructuralSurfaceReactionToStore(editor, anchor, { AppliedLoad: { PlanarForceX: 1 } })).toThrow(/IFC2X3/);
      expect(() => addStructuralSurfaceActionToStore(editor, anchor, { AppliedLoad: { Type: 'IfcStructuralLoadPlanarForce', PlanarForceX: 1 } })).toThrow(/IFC2X3/);
    }
    expect(editor.getMutationView().getNewEntities()).toHaveLength(0);
  });
});

// #9764 independent review: untyped SDK callers must not author invalid STEP.
describe.each(['IFC2X3', 'IFC4', 'IFC4X3'])('%s runtime activity validation (#9764)', schema => {
  const builders = [
    [addStructuralPlanarActionToStore, { AppliedLoad: { Type: 'IfcStructuralLoadPlanarForce', PlanarForceZ: 1 } }],
    [addStructuralPointReactionToStore, { AppliedLoad: { Type: 'IfcStructuralLoadSingleForce', ForceZ: 1 } }],
    ...(schema === 'IFC2X3' ? [] : [
      [addStructuralSurfaceActionToStore, { AppliedLoad: { Type: 'IfcStructuralLoadPlanarForce', PlanarForceZ: 1 } }],
      [addStructuralCurveReactionToStore, { AppliedLoad: { LinearForceZ: 1 } }],
      [addStructuralSurfaceReactionToStore, { AppliedLoad: { PlanarForceZ: 1 } }],
    ] as const),
  ] as const;

  if (schema === 'IFC2X3') {
    it('requires OwnerHistory even when a direct caller bypasses resolveSpatialAnchor (#9764)', async () => {
      const { editor, anchor } = await fresh(schema);
      for (const [builder, params] of [...builders, [addStructuralResultGroupToStore, {
        TheoryType: 'FIRST_ORDER_THEORY', IsLinear: true, ResultForLoadGroup: 1, ReactionIds: [30],
      }]] as const) {
        for (const ownerHistoryId of [null, undefined]) {
          expect(() => Reflect.apply(builder, undefined, [editor, { ...anchor, ownerHistoryId }, params]))
            .toThrow(`${builder.name}: IFC2X3 requires ownerHistoryId (IfcRoot.OwnerHistory)`);
          expect(editor.getMutationView().getNewEntities()).toHaveLength(0);
        }
      }
    });
  } else {
    it('keeps optional OwnerHistory and absent load names valid on IFC4+ (#9764)', async () => {
      const { editor, anchor, roundTrip } = await fresh(schema);
      const ids = builders.map(([builder, params]) => Reflect.apply(builder, undefined, [
        editor, { ...anchor, ownerHistoryId: null }, { ...params, AppliedLoad: { ...params.AppliedLoad, Name: null } },
      ]));
      const { attrs } = await roundTrip();
      for (const { activityId, loadId } of ids) {
        expect(attrs(activityId)[1]).toBeNull();
        expect(attrs(loadId)[0]).toBeNull();
      }
    });
  }

  it('rejects non-text AppliedLoad.Name before writing (#9764)', async () => {
    const { editor, anchor } = await fresh(schema);
    for (const [builder, params] of builders) {
      for (const Name of [42, true, [], {}]) {
        expect(() => Reflect.apply(builder, undefined, [editor, anchor, {
          ...params, AppliedLoad: { ...params.AppliedLoad, Name },
        }])).toThrow(`${builder.name}: AppliedLoad.Name must be a string`);
        expect(editor.getMutationView().getNewEntities()).toHaveLength(0);
      }
    }
  });

  it('rejects invalid GlobalOrLocal with the method and allowed values before writing', async () => {
    const { editor, anchor } = await fresh(schema);
    for (const [builder, params] of builders) {
      for (const GlobalOrLocal of ['FOO', null, true, 1]) {
        expect(() => Reflect.apply(builder, undefined, [editor, anchor, { ...params, GlobalOrLocal }]))
          .toThrow(`${builder.name}: GlobalOrLocal must be one of GLOBAL_COORDS, LOCAL_COORDS`);
        expect(editor.getMutationView().getNewEntities()).toHaveLength(0);
      }
    }
  });

  it('rejects missing or non-object AppliedLoad with the method and field', async () => {
    const { editor, anchor } = await fresh(schema);
    for (const [builder] of builders) {
      for (const AppliedLoad of [undefined, null, 'force', 1, []]) {
        expect(() => Reflect.apply(builder, undefined, [editor, anchor, { AppliedLoad }]))
          .toThrow(`${builder.name}: AppliedLoad must be a load object`);
        expect(editor.getMutationView().getNewEntities()).toHaveLength(0);
      }
    }
  });

  it('rejects invalid surface action enums and booleans before writing', async () => {
    const { editor, anchor } = await fresh(schema);
    const actions = schema === 'IFC2X3' ? [addStructuralPlanarActionToStore] : [addStructuralPlanarActionToStore, addStructuralSurfaceActionToStore];
    for (const builder of actions) {
      for (const [field, value, allowed] of [
        ['DestabilizingLoad', 'yes', 'true or false'], ['DestabilizingLoad', null, 'true or false'],
        ['ProjectedOrTrue', 'BOGUS', 'one of PROJECTED_LENGTH, TRUE_LENGTH'], ['ProjectedOrTrue', true, 'one of PROJECTED_LENGTH, TRUE_LENGTH'],
      ] as const) {
        expect(() => Reflect.apply(builder, undefined, [editor, anchor, {
          AppliedLoad: { Type: 'IfcStructuralLoadPlanarForce', PlanarForceZ: 1 }, [field]: value,
        }])).toThrow(`${builder.name}: ${field} must be ${allowed}`);
        expect(editor.getMutationView().getNewEntities()).toHaveLength(0);
      }
    }
  });

  it('rejects invalid result group TheoryType and IsLinear before writing', async () => {
    const { editor, anchor } = await fresh(schema);
    for (const [field, value, allowed] of [
      ['TheoryType', 'NOPE', 'one of FIRST_ORDER_THEORY, SECOND_ORDER_THEORY, THIRD_ORDER_THEORY, FULL_NONLINEAR_THEORY, USERDEFINED, NOTDEFINED'],
      ['TheoryType', undefined, 'one of FIRST_ORDER_THEORY, SECOND_ORDER_THEORY, THIRD_ORDER_THEORY, FULL_NONLINEAR_THEORY, USERDEFINED, NOTDEFINED'],
      ['IsLinear', 'yes', 'true or false'], ['IsLinear', undefined, 'true or false'],
    ] as const) {
      expect(() => Reflect.apply(addStructuralResultGroupToStore, undefined, [editor, anchor, {
        TheoryType: 'FIRST_ORDER_THEORY', IsLinear: true, ResultForLoadGroup: 1, ReactionIds: [30], [field]: value,
      }])).toThrow(`addStructuralResultGroupToStore: ${field} must be ${allowed}`);
      expect(editor.getMutationView().getNewEntities()).toHaveLength(0);
    }
  });

  it('uses the established human-readable default activity names', async () => {
    const { editor, anchor, roundTrip } = await fresh(schema);
    for (const [builder, params] of builders) Reflect.apply(builder, undefined, [editor, anchor, params]);
    const member = addStructuralCurveMemberToStore(editor, anchor, { Start: [0, 0, 0], End: [1, 0, 0] });
    for (const activity of editor.getMutationView().getNewEntities().filter(e => e.type.endsWith('Action') || e.type.endsWith('Reaction'))) {
      connectStructuralActivityToItemInStore(editor, anchor.ownerHistoryId, member.memberId, activity.expressId);
    }
    const { data } = await roundTrip();
    expect(data.activities.map(a => a.name)).toEqual(schema === 'IFC2X3'
      ? ['Planar Action', 'Point Reaction']
      : ['Planar Action', 'Point Reaction', 'Surface Action', 'Curve Reaction', 'Surface Reaction']);
  });
});

it('omitted anchor schema uses the documented IFC4 default (#9764)', async () => {
  const { editor, anchor, roundTrip } = await fresh('IFC4');
  const defaultAnchor = { ...anchor, schema: undefined, ownerHistoryId: null };
  addStructuralSurfaceActionToStore(editor, defaultAnchor, { AppliedLoad: { Type: 'IfcStructuralLoadPlanarForce', PlanarForceZ: 1 } });
  addStructuralCurveReactionToStore(editor, defaultAnchor, { AppliedLoad: { LinearForceZ: 2 } });
  addStructuralSurfaceReactionToStore(editor, defaultAnchor, { AppliedLoad: { PlanarForceZ: 3 } });
  const { data } = await roundTrip();
  expect(data.activities.map(a => a.type)).toEqual(['IfcStructuralSurfaceAction', 'IfcStructuralCurveReaction', 'IfcStructuralSurfaceReaction']);
});
