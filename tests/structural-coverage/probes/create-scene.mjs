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

/** IFC4 stiffness slots are SELECTs, so a fixed or free degree of freedom is the typed IfcBoolean branch. */
const FIXED = { type: 'IFCBOOLEAN', value: true };
const FREE = { type: 'IFCBOOLEAN', value: false };
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

/** Each shape representation describes exactly one station, in sample order. */
const stationShape = (id, count) => ({
  id, builder: 'ShapeAspect scene geometry', emits: {}, needs: ['surface-member'],
  build: ({ editor, anchor, done }) => {
    const reps = Array.from({ length: count }, (_, i) => {
      const position = count === 3 ? [[0,0,0],[4,0,0],[0,3,0]][i] : [4 * i,0,0];
      const p = editor.addEntity('IfcCartesianPoint', [position]).expressId;
      return `#${editor.addEntity('IfcShapeRepresentation', [`#${anchor.axisContextId}`, 'Reference', 'Point', [`#${p}`]]).expressId}`;
    });
    const shape = editor.getNewEntity(done.get('surface-member')).attributes[6];
    return editor.addEntity('IfcShapeAspect', [reps, 'Stations', null, true, shape]).expressId;
  },
});

export const SCENE = [
  {
    id: 'surface-member', builder: 'addStructuralSurfaceMemberToStore',
    emits: { IfcStructuralSurfaceMember: { Name: 'Probe plate', PredefinedType: 'SHELL', Thickness: 0.2 } },
    build: ({ create, editor, anchor }) => create.addStructuralSurfaceMemberToStore(editor, anchor, { Boundary: [[0,0,0],[4,0,0],[4,3,0],[0,3,0]], Name: 'Probe plate', PredefinedType: 'SHELL', Thickness: 0.2 }).memberId,
  },
  {
    id: 'curve-connection', builder: 'addStructuralCurveConnectionToStore',
    emits: schema => ({ IfcStructuralCurveConnection: { Name: 'Probe edge support' }, IfcBoundaryEdgeCondition: { Name: 'Probe edge condition', [schema === 'IFC2X3' ? 'LinearStiffnessByLengthX' : 'TranslationalStiffnessByLengthX']: schema === 'IFC2X3' ? -1 : FIXED } }),
    build: ({ create, editor, anchor }) => create.addStructuralCurveConnectionToStore(editor, anchor, { Start: [0,0,0], End: [4,0,0], Name: 'Probe edge support', BoundaryCondition: { Name: 'Probe edge condition', TranslationalStiffnessByLengthX: true } }).connectionId,
  },
  {
    id: 'surface-connection', builder: 'addStructuralSurfaceConnectionToStore',
    emits: schema => ({ IfcStructuralSurfaceConnection: { Name: 'Probe face support' }, IfcBoundaryFaceCondition: { Name: 'Probe face condition', [schema === 'IFC2X3' ? 'LinearStiffnessByAreaZ' : 'TranslationalStiffnessByAreaZ']: schema === 'IFC2X3' ? -1 : FIXED } }),
    build: ({ create, editor, anchor }) => create.addStructuralSurfaceConnectionToStore(editor, anchor, { Boundary: [[0,0,0],[4,0,0],[4,3,0],[0,3,0]], Name: 'Probe face support', BoundaryCondition: { Name: 'Probe face condition', TranslationalStiffnessByAreaZ: true } }).connectionId,
  },
  // IfcStructuralConnection.ConnectsStructuralMembers is INVERSE SET [1:?], so
  // each connection above needs a member for the scene to be valid IFC.
  ...['curve-connection', 'surface-connection'].map((c) => ({
    id: `surface-member-to-${c}`, builder: 'connectStructuralMemberToConnectionInStore',
    needs: ['surface-member', c], emits: {},
    build: ({ create, editor, anchor, done }) => create.connectStructuralMemberToConnectionInStore(editor, anchor.ownerHistoryId, done.get('surface-member'), done.get(c)),
  })),
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
    // IFC2X3 fixed/free stiffness uses the EXPRESS measure convention -1/0.
    emits: (schema) => ({
      IfcStructuralPointConnection: { GlobalId: G.connection, Name: 'Probe support' },
      IfcBoundaryNodeCondition: schema === 'IFC2X3'
        ? { Name: 'Probe pinned', LinearStiffnessX: -1, LinearStiffnessY: -1, LinearStiffnessZ: -1, RotationalStiffnessX: 0, RotationalStiffnessY: 0, RotationalStiffnessZ: 0 }
        : { Name: 'Probe pinned', TranslationalStiffnessX: FIXED, TranslationalStiffnessY: FIXED, TranslationalStiffnessZ: FIXED, RotationalStiffnessX: FREE, RotationalStiffnessY: FREE, RotationalStiffnessZ: FREE },
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
  {
    id: 'PlanarAction-PlanarForce', builder: 'addStructuralPlanarActionToStore',
    emits: (schema) => ({
      IfcStructuralPlanarAction: { GlobalId: guid('C30'), GlobalOrLocal: 'GLOBAL_COORDS' },
      IfcStructuralLoadPlanarForce: { "PlanarForceZ": -4 },
    }),
    build: ({ create, editor, anchor }) => create.addStructuralPlanarActionToStore(editor, anchor, {
      GlobalId: guid('C30'), AppliedLoad: { Type: 'IfcStructuralLoadPlanarForce', "PlanarForceZ": -4 },
    }).activityId,
  },
  {
    id: 'SurfaceAction-PlanarForce', builder: 'addStructuralSurfaceActionToStore',
    schemas: ["IFC4", "IFC4X3"],
    emits: (schema) => ({
      IfcStructuralSurfaceAction: { GlobalId: guid('C31'), GlobalOrLocal: 'GLOBAL_COORDS' },
      IfcStructuralLoadPlanarForce: { "PlanarForceZ": -5 },
    }),
    build: ({ create, editor, anchor }) => create.addStructuralSurfaceActionToStore(editor, anchor, {
      GlobalId: guid('C31'), AppliedLoad: { Type: 'IfcStructuralLoadPlanarForce', "PlanarForceZ": -5 },
    }).activityId,
  },
  {
    id: 'PlanarAction-Temperature', builder: 'addStructuralPlanarActionToStore',
    emits: (schema) => ({
      IfcStructuralPlanarAction: { GlobalId: guid('C32'), GlobalOrLocal: 'GLOBAL_COORDS' },
      IfcStructuralLoadTemperature: (schema === 'IFC2X3' ? { DeltaT_Constant: 12, DeltaT_Y: 2, DeltaT_Z: -3 } : { "DeltaTConstant": 12, "DeltaTY": 2, "DeltaTZ": -3 }),
    }),
    build: ({ create, editor, anchor }) => create.addStructuralPlanarActionToStore(editor, anchor, {
      GlobalId: guid('C32'), AppliedLoad: { Type: 'IfcStructuralLoadTemperature', "DeltaTConstant": 12, "DeltaTY": 2, "DeltaTZ": -3 },
    }).activityId,
  },
  {
    id: 'PointReaction-SingleForce', builder: 'addStructuralPointReactionToStore',
    emits: (schema) => ({
      IfcStructuralPointReaction: { GlobalId: guid('C33'), GlobalOrLocal: 'GLOBAL_COORDS' },
      IfcStructuralLoadSingleForce: { "ForceZ": 10 },
    }),
    build: ({ create, editor, anchor }) => create.addStructuralPointReactionToStore(editor, anchor, {
      GlobalId: guid('C33'), AppliedLoad: { Type: 'IfcStructuralLoadSingleForce', "ForceZ": 10 },
    }).activityId,
  },
  {
    id: 'PointReaction-SingleDisplacement', builder: 'addStructuralPointReactionToStore',
    emits: (schema) => ({
      IfcStructuralPointReaction: { GlobalId: guid('C34'), GlobalOrLocal: 'GLOBAL_COORDS' },
      IfcStructuralLoadSingleDisplacement: { "DisplacementZ": 0.02 },
    }),
    build: ({ create, editor, anchor }) => create.addStructuralPointReactionToStore(editor, anchor, {
      GlobalId: guid('C34'), AppliedLoad: { Type: 'IfcStructuralLoadSingleDisplacement', "DisplacementZ": 0.02 },
    }).activityId,
  },
  {
    id: 'CurveReaction-LinearForce', builder: 'addStructuralCurveReactionToStore',
    schemas: ["IFC4", "IFC4X3"],
    emits: (schema) => ({
      IfcStructuralCurveReaction: { GlobalId: guid('C35'), GlobalOrLocal: 'GLOBAL_COORDS' },
      IfcStructuralLoadLinearForce: { "LinearForceZ": 2 },
    }),
    build: ({ create, editor, anchor }) => create.addStructuralCurveReactionToStore(editor, anchor, {
      GlobalId: guid('C35'), AppliedLoad: { "LinearForceZ": 2 },
    }).activityId,
  },
  {
    id: 'SurfaceReaction-PlanarForce', builder: 'addStructuralSurfaceReactionToStore',
    schemas: ["IFC4", "IFC4X3"],
    emits: (schema) => ({
      IfcStructuralSurfaceReaction: { GlobalId: guid('C36'), GlobalOrLocal: 'GLOBAL_COORDS' },
      IfcStructuralLoadPlanarForce: { "PlanarForceZ": 3 },
    }),
    build: ({ create, editor, anchor }) => create.addStructuralSurfaceReactionToStore(editor, anchor, {
      GlobalId: guid('C36'), AppliedLoad: { "PlanarForceZ": 3 },
    }).activityId,
  },
  {
    id: 'warping-support', builder: 'addStructuralPointConnectionToStore',
    emits: schema => ({ IfcBoundaryNodeConditionWarping: { Name: 'Warping', WarpingStiffness: schema === 'IFC2X3' ? 12 : { type: 'IFCWARPINGMOMENTMEASURE', value: 12 } } }),
    build: ({ create, editor, anchor }) => create.addStructuralPointConnectionToStore(editor, anchor, { Position: [0,0,0], BoundaryCondition: { Name: 'Warping', WarpingStiffness: 12 } }).connectionId,
  },
  ...['IfcFailureConnectionCondition', 'IfcSlippageConnectionCondition'].map((Type, i) => ({
    id: Type, builder: 'connectStructuralMemberToConnectionInStore', needs: ['curve-member', 'warping-support'],
    emits: {
      [Type]: i ? { Name: Type, SlippageX: 0.1, SlippageY: 0.2, SlippageZ: 0.3 } : { Name: Type, TensionFailureX: 10, CompressionFailureZ: 20 },
      ...(i ? {} : { IfcRelConnectsWithEccentricity: { RelatingStructuralMember: G.member }, IfcConnectionPointEccentricity: { EccentricityInX: 0.1, EccentricityInY: 0.2, EccentricityInZ: 0.3 } }),
    },
    build: ({ create, editor, anchor, done }) => create.connectStructuralMemberToConnectionInStore(editor, anchor.ownerHistoryId, done.get('curve-member'), done.get('warping-support'), undefined, {
      AdditionalConditions: i ? { Type, Name: Type, SlippageX: 0.1, SlippageY: 0.2, SlippageZ: 0.3 } : { Type, Name: Type, TensionFailureX: 10, CompressionFailureZ: 20 },
      ...(i ? {} : { ConnectionConstraint: { PointOnRelatingElement: [0,0,0], PointOnRelatedElement: [0.1,0.2,0.3], EccentricityInX: 0.1, EccentricityInY: 0.2, EccentricityInZ: 0.3 } }),
    }),
  })),
  {
    id: 'varying-curve-member', builder: 'addStructuralCurveMemberToStore',
    emits: { IfcStructuralCurveMemberVarying: { Name: 'Varying curve', PredefinedType: 'RIGID_JOINED_MEMBER' } },
    build: ({ create, editor, anchor }) => create.addStructuralCurveMemberToStore(editor, anchor, { Type: 'IfcStructuralCurveMemberVarying', Name: 'Varying curve', Start: [0,0,0], End: [3,0,0], PredefinedType: 'RIGID_JOINED_MEMBER' }).memberId,
  },
  stationShape('stations', 3),
  stationShape('surface-stations', 3),
  stationShape('linear-stations', 2),
  {
    id: 'varying-surface-member', builder: 'addStructuralSurfaceMemberToStore', needs: ['surface-stations'],
    emits: schema => ({ IfcStructuralSurfaceMemberVarying: { Name: 'Varying surface', Thickness: 0.2, ...(schema === 'IFC2X3' ? { SubsequentThickness: [0.3,0.4] } : {}) } }),
    build: ({ create, editor, anchor, done }) => {
      const result = create.addStructuralSurfaceMemberToStore(editor, anchor, { Type: 'IfcStructuralSurfaceMemberVarying', Name: 'Varying surface', Boundary: [[0,0,0],[4,0,0],[4,3,0],[0,3,0]], Thickness: 0.2, ...(anchor.schema === 'IFC2X3' ? { SubsequentThickness: [0.3,0.4], VaryingThicknessLocation: done.get('surface-stations') } : {}) });
      if (anchor.schema === 'IFC2X3') editor.setPositionalAttribute(done.get('surface-stations'), 4, `#${result.productShapeId}`);
      return result.memberId;
    },
  },
  ...['IfcStructuralLoadSingleForceWarping', 'IfcStructuralLoadSingleDisplacementDistortion'].map((Type, i) => ({
    id: Type, builder: 'addStructuralPointReactionToStore',
    emits: { [Type]: i ? { Name: Type, DisplacementZ: 0.02, Distortion: 0.03 } : { Name: Type, ForceZ: 10, WarpingMoment: 20 } },
    build: ({ create, editor, anchor }) => create.addStructuralPointReactionToStore(editor, anchor, { AppliedLoad: { Type, Name: Type, ...(i ? { DisplacementZ: 0.02, Distortion: 0.03 } : { ForceZ: 10, WarpingMoment: 20 }) } }).loadId,
  })),
  {
    id: 'reinforcement', builder: 'addStructuralLoadToStore', schemas: ['IFC4','IFC4X3'],
    emits: { IfcSurfaceReinforcementArea: { Name: 'Reinforcement', SurfaceReinforcement1: [0.01,0.02], SurfaceReinforcement2: [0.03,0.04,0.05], ShearReinforcement: 0.006 } },
    build: ({ create, editor, anchor }) => create.addStructuralLoadToStore(editor, anchor, { Type: 'IfcSurfaceReinforcementArea', Name: 'Reinforcement', SurfaceReinforcement1: [0.01,0.02], SurfaceReinforcement2: [0.03,0.04,0.05], ShearReinforcement: 0.006 }),
  },
  {
    id: 'configuration-second-load', builder: 'addStructuralLinearActionToStore', schemas: ['IFC4','IFC4X3'], emits: {},
    build: ({ create, editor, anchor }) => create.addStructuralLinearActionToStore(editor, anchor, { LoadName: 'Configuration end force', LinearForceZ: -7.5 }).loadId,
  },
  {
    id: 'load-configuration', builder: 'addStructuralLoadToStore', schemas: ['IFC4','IFC4X3'], needs: ['linear-action', 'configuration-second-load'],
    emits: { IfcStructuralLoadConfiguration: { Name: 'Configuration', Locations: [[0],[1]] } },
    build: ({ create, editor, anchor, done }) => create.addStructuralLoadToStore(editor, anchor, { Type: 'IfcStructuralLoadConfiguration', Name: 'Configuration', Values: [Number(editor.getNewEntity(done.get('linear-action')).attributes[7].slice(1)), done.get('configuration-second-load')], Locations: [[0],[1]] }),
  },
  {
    id: 'curve-action', builder: 'addStructuralCurveActionToStore', schemas: ['IFC4','IFC4X3'], needs: ['load-configuration'],
    emits: { IfcStructuralCurveAction: { Name: 'Configured curve', PredefinedType: 'LINEAR' } },
    build: ({ create, editor, anchor, done }) => create.addStructuralCurveActionToStore(editor, anchor, { Name: 'Configured curve', AppliedLoad: done.get('load-configuration'), PredefinedType: 'LINEAR' }),
  },
  ...['Linear', 'Planar'].map(kind => ({
    id: `varying-${kind}`, builder: `addStructural${kind}ActionToStore`, schemas: ['IFC2X3'], needs: ['stations', 'linear-stations'],
    emits: { [`IfcStructural${kind}ActionVarying`]: { Name: `Varying ${kind}` } },
    build: ({ create, editor, anchor, done }) => {
      const planar = kind === 'Planar';
      const base = planar ? create.addStructuralPlanarActionToStore(editor, anchor, { AppliedLoad: { Type: 'IfcStructuralLoadPlanarForce', PlanarForceZ: -3 } }) : create.addStructuralLinearActionToStore(editor, anchor, { LinearForceZ: -3 });
      return create[`addStructural${kind}ActionToStore`](editor, anchor, { Name: `Varying ${kind}`, VaryingAppliedLoadLocation: done.get(planar ? 'stations' : 'linear-stations'), SubsequentAppliedLoads: planar ? [base.loadId, create.addStructuralPlanarActionToStore(editor, anchor, { AppliedLoad: { Type: 'IfcStructuralLoadPlanarForce', PlanarForceZ: -4 } }).loadId] : [base.loadId], ...(planar ? { AppliedLoad: { Type: 'IfcStructuralLoadPlanarForce', PlanarForceZ: -2 } } : { LinearForceZ: -2 }) }).activityId;
    },
  })),
  {
    id: 'physical-element', builder: 'addBeamToStore', schemas: ['IFC2X3'], emits: {},
    build: ({ create, editor, anchor }) => create.addBeamToStore(editor, anchor, { Start: [0,0,0], End: [5,0,0], Width: 0.2, Height: 0.3 }).beamId,
  },
  {
    id: 'structural-element-link', builder: 'connectStructuralElementInStore', schemas: ['IFC2X3'], needs: ['physical-element','curve-member'],
    emits: { IfcRelConnectsStructuralElement: { RelatedStructuralMember: G.member } },
    build: ({ create, editor, anchor, done }) => create.connectStructuralElementInStore(editor, anchor.ownerHistoryId, done.get('physical-element'), done.get('curve-member')),
  },
  {
    id: 'result-group', builder: 'addStructuralResultGroupToStore',
    needs: ['load-group', 'PointReaction-SingleForce', 'PointReaction-SingleDisplacement'],
    emits: { IfcStructuralResultGroup: { GlobalId: guid('Results'), TheoryType: 'FIRST_ORDER_THEORY', ResultForLoadGroup: G.group, IsLinear: true } },
    build: ({ create, editor, anchor, done }) => create.addStructuralResultGroupToStore(editor, anchor, {
      GlobalId: guid('Results'), TheoryType: 'FIRST_ORDER_THEORY', ResultForLoadGroup: done.get('load-group'), IsLinear: true,
      ReactionIds: editor.getMutationView().getNewEntities().filter(e => /IfcStructural.*Reaction$/i.test(e.type)).map(e => e.expressId),
    }).resultGroupId,
  },
  analysisModel('analysis-model-ifc2x3', ['IFC2X3'], ['load-group'], [G.group]),
  analysisModel('analysis-model', ['IFC4', 'IFC4X3'], ['load-group', 'load-case'], [G.group, G.loadCase]),
  {
    id: 'complete-graph', builder: 'structural relationship builders', emits: {},
    build: ({ create, editor, anchor, done }) => {
      const entities = editor.getMutationView().getNewEntities();
      const activities = entities.filter(e => /IfcStructural.*(Action|Reaction)/i.test(e.type));
      const linked = new Set(entities.filter(e => e.type.toUpperCase() === 'IFCRELCONNECTSSTRUCTURALACTIVITY').map(e => e.attributes[5]));
      for (const activity of activities) if (!linked.has(`#${activity.expressId}`)) create.connectStructuralActivityToItemInStore(editor, anchor.ownerHistoryId, done.get('curve-member'), activity.expressId);
      create.assignToStructuralGroupInStore(editor, anchor.ownerHistoryId, done.get('load-group'), activities.filter(e => !/Reaction/i.test(e.type)).map(e => e.expressId));
      create.assignToStructuralGroupInStore(editor, anchor.ownerHistoryId, done.get(anchor.schema === 'IFC2X3' ? 'analysis-model-ifc2x3' : 'analysis-model'), [done.get('curve-member'), done.get('point-connection'), done.get('surface-member')]);
    },
  },
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
FILE_SCHEMA(('${schema === 'IFC4X3' ? 'IFC4X3_ADD2' : schema}'));
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
