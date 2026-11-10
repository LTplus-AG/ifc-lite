/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The builder scene the `create` probe runs once per schema.
 *
 * Each step calls one in-store builder and lists, per entity it emits, the
 * attribute values (EXPRESS names, STEP-normalised: references to rooted
 * entities as their GlobalId, booleans as true/false) the exported record must
 * carry, or a function of the schema returning that. An entity's `unchecked` lists
 * attributes with no expected value yet; it caps the cell at partial. `needs` names earlier steps
 * whose results it uses; `schemas` limits a step to the schemas that have its
 * entities (omit it to run everywhere).
 *
 * To register a new builder: append a step. Nothing else changes.
 */

const guid = (tag) => `0SC${tag}`.padEnd(22, '0').slice(0, 22);
const G = {
  member: guid('Member'), connection: guid('Connection'), point: guid('PointAction'),
  linear: guid('LinearAction'), group: guid('LoadGroup'), loadCase: guid('LoadCase'), model: guid('AnalysisModel'),
};

/** The analysis model is loaded by the load groups the schema has; IFC2X3 has no load case. */
const analysisModel = (id, schemas, needs, loadedBy) => ({
  id,
  builder: 'addStructuralAnalysisModelToStore',
  schemas,
  needs,
  emits: { IfcStructuralAnalysisModel: { GlobalId: G.model, Name: 'Probe model', PredefinedType: 'LOADING_3D', LoadedBy: loadedBy } },
  build: ({ create, editor, anchor, done }) => create.addStructuralAnalysisModelToStore(editor, anchor, {
    Name: 'Probe model', GlobalId: G.model, PredefinedType: 'LOADING_3D', LoadGroupIds: needs.map((n) => done.get(n)),
  }).analysisModelId,
});

export const SCENE = [
  {
    id: 'curve-member',
    builder: 'addStructuralCurveMemberToStore',
    emits: { IfcStructuralCurveMember: { GlobalId: G.member, Name: 'Probe member', PredefinedType: 'RIGID_JOINED_MEMBER' } },
    build: ({ create, editor, anchor }) => create.addStructuralCurveMemberToStore(editor, anchor, {
      Start: [0, 0, 0], End: [5, 0, 0], PredefinedType: 'RIGID_JOINED_MEMBER', Name: 'Probe member', GlobalId: G.member,
    }).memberId,
  },
  {
    id: 'point-connection',
    builder: 'addStructuralPointConnectionToStore',
    // IFC2X3 names the stiffness attributes Linear* and has no boolean branch. The expected IFC2X3
    // values follow from the decided mapping of a fixed (true) or free (false) degree of freedom, written down with the
    // IFC2X3 builder, not copied from its output; until then `unchecked` caps the cell at partial.
    emits: (schema) => ({
      IfcStructuralPointConnection: { GlobalId: G.connection, Name: 'Probe support' },
      IfcBoundaryNodeCondition: schema === 'IFC2X3'
        ? { Name: 'Probe pinned', unchecked: ['LinearStiffnessX', 'LinearStiffnessY', 'LinearStiffnessZ', 'RotationalStiffnessX', 'RotationalStiffnessY', 'RotationalStiffnessZ'] }
        : { Name: 'Probe pinned', TranslationalStiffnessX: true, TranslationalStiffnessY: true, TranslationalStiffnessZ: true, RotationalStiffnessX: false, RotationalStiffnessY: false, RotationalStiffnessZ: false },
    }),
    build: ({ create, editor, anchor }) => create.addStructuralPointConnectionToStore(editor, anchor, {
      Position: [0, 0, 0], Name: 'Probe support', GlobalId: G.connection,
      BoundaryCondition: { Name: 'Probe pinned', TranslationalStiffnessX: true, TranslationalStiffnessY: true, TranslationalStiffnessZ: true, RotationalStiffnessX: false, RotationalStiffnessY: false, RotationalStiffnessZ: false },
    }).connectionId,
  },
  {
    id: 'member-to-connection',
    builder: 'connectStructuralMemberToConnectionInStore',
    needs: ['curve-member', 'point-connection'],
    emits: { IfcRelConnectsStructuralMember: { RelatingStructuralMember: G.member, RelatedStructuralConnection: G.connection } },
    build: ({ create, editor, anchor, done }) => create.connectStructuralMemberToConnectionInStore(editor, anchor.ownerHistoryId, done.get('curve-member'), done.get('point-connection')),
  },
  {
    id: 'point-action',
    builder: 'addStructuralPointActionToStore',
    emits: {
      IfcStructuralPointAction: { GlobalId: G.point, Name: 'Probe point load', GlobalOrLocal: 'GLOBAL_COORDS', DestabilizingLoad: false },
      IfcStructuralLoadSingleForce: { Name: 'Probe force', ForceZ: -10 },
    },
    build: ({ create, editor, anchor }) => create.addStructuralPointActionToStore(editor, anchor, {
      Name: 'Probe point load', GlobalId: G.point, LoadName: 'Probe force', ForceZ: -10, DestabilizingLoad: false,
    }).activityId,
  },
  {
    id: 'action-to-connection',
    builder: 'connectStructuralActivityToItemInStore',
    needs: ['point-connection', 'point-action'],
    emits: { IfcRelConnectsStructuralActivity: { RelatingElement: G.connection, RelatedStructuralActivity: G.point } },
    build: ({ create, editor, anchor, done }) => create.connectStructuralActivityToItemInStore(editor, anchor.ownerHistoryId, done.get('point-connection'), done.get('point-action')),
  },
  {
    id: 'linear-action',
    builder: 'addStructuralLinearActionToStore',
    emits: {
      IfcStructuralLinearAction: { GlobalId: G.linear, Name: 'Probe line load', GlobalOrLocal: 'GLOBAL_COORDS' },
      IfcStructuralLoadLinearForce: { Name: 'Probe line force', LinearForceZ: -2.5 },
    },
    build: ({ create, editor, anchor }) => create.addStructuralLinearActionToStore(editor, anchor, {
      Name: 'Probe line load', GlobalId: G.linear, LoadName: 'Probe line force', LinearForceZ: -2.5,
    }).activityId,
  },
  {
    id: 'load-group',
    builder: 'addStructuralLoadGroupToStore',
    emits: { IfcStructuralLoadGroup: { GlobalId: G.group, Name: 'Probe group', PredefinedType: 'LOAD_GROUP', ActionType: 'PERMANENT_G', ActionSource: 'DEAD_LOAD_G', Coefficient: 1.35 } },
    build: ({ create, editor, anchor }) => create.addStructuralLoadGroupToStore(editor, anchor, {
      Name: 'Probe group', GlobalId: G.group, ActionType: 'PERMANENT_G', ActionSource: 'DEAD_LOAD_G', Coefficient: 1.35,
    }).loadGroupId,
  },
  {
    id: 'load-case',
    builder: 'addStructuralLoadGroupToStore',
    schemas: ['IFC4', 'IFC4X3'],
    emits: { IfcStructuralLoadCase: { GlobalId: G.loadCase, Name: 'Probe case', PredefinedType: 'LOAD_CASE', ActionType: 'VARIABLE_Q', ActionSource: 'LIVE_LOAD_Q', SelfWeightCoefficients: [0, 0, -1] } },
    build: ({ create, editor, anchor }) => create.addStructuralLoadGroupToStore(editor, anchor, {
      Name: 'Probe case', GlobalId: G.loadCase, ActionType: 'VARIABLE_Q', ActionSource: 'LIVE_LOAD_Q', SelfWeightCoefficients: [0, 0, -1],
    }).loadGroupId,
  },
  analysisModel('analysis-model-ifc2x3', ['IFC2X3'], ['load-group'], [G.group]),
  analysisModel('analysis-model', ['IFC4', 'IFC4X3'], ['load-group', 'load-case'], [G.group, G.loadCase]),
];

/** The steps that run in `schema`, with `emits` resolved for it. */
export const stepsFor = (schema) => SCENE.filter((s) => !s.schemas || s.schemas.includes(schema))
  .map((s) => (typeof s.emits === 'function' ? { ...s, emits: s.emits(schema) } : s));

/** A blank one-storey model in `schema`, with the owner history IFC2X3 requires. */
export function blankModel(schema) {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('structural coverage probe'),'2;1');
FILE_NAME('blank.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
#1=IFCPERSON($,'Probe',$,$,$,$,$,$);
#2=IFCORGANIZATION($,'Probe',$,$,$);
#3=IFCPERSONANDORGANIZATION(#1,#2,$);
#4=IFCAPPLICATION(#2,'0','structural coverage probe','probe');
#5=IFCOWNERHISTORY(#3,#4,$,.NOCHANGE.,$,$,$,1767225600);
#10=IFCPROJECT('0SCProject000000000000',#5,'Probe',$,$,$,$,(#20),#30);
#11=IFCCARTESIANPOINT((0.,0.,0.));
#12=IFCAXIS2PLACEMENT3D(#11,$,$);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#12,$);
#30=IFCUNITASSIGNMENT((#31,#32,#33));
#31=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#32=IFCSIUNIT(*,.FORCEUNIT.,.KILO.,.NEWTON.);
#33=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#40=IFCLOCALPLACEMENT($,#12);
#41=IFCSITE('0SCSite000000000000000',#5,'Site',$,$,#40,$,$,.ELEMENT.,$,$,$,$,$);
#42=IFCLOCALPLACEMENT(#40,#12);
#43=IFCBUILDING('0SCBuilding00000000000',#5,'Building',$,$,#42,$,$,.ELEMENT.,$,$,$);
#44=IFCLOCALPLACEMENT(#42,#12);
#45=IFCBUILDINGSTOREY('0SCStorey0000000000000',#5,'Level 0',$,$,#44,$,$,.ELEMENT.,0.);
#50=IFCRELAGGREGATES('0SCRelAggregates100000',#5,$,$,#10,(#41));
#51=IFCRELAGGREGATES('0SCRelAggregates200000',#5,$,$,#41,(#43));
#52=IFCRELAGGREGATES('0SCRelAggregates300000',#5,$,$,#43,(#45));
ENDSEC;
END-ISO-10303-21;
`;
}
