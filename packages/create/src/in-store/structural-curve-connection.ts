/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreEditor } from '@ifc-lite/mutations';
import { assertFinitePoint3, vecCross, vecLen, vecNorm } from '../ifc-creator-math.js';
import type { Point3D } from '../types.js';
import { toNativePoint3, type SpatialAnchor } from './anchor.js';
import { emitLocalPlacement, ownerHistoryRef, productGuid } from './_emit-helpers.js';
import { assertStructuralBuilderSchema, structuralStiffness } from './_structural-stiffness.js';

export interface StructuralBoundaryEdgeConditionParams {
  Name?: string;
  TranslationalStiffnessByLengthX?: boolean | number;
  TranslationalStiffnessByLengthY?: boolean | number;
  TranslationalStiffnessByLengthZ?: boolean | number;
  RotationalStiffnessByLengthX?: boolean | number;
  RotationalStiffnessByLengthY?: boolean | number;
  RotationalStiffnessByLengthZ?: boolean | number;
}

export interface StructuralCurveConnectionInStoreParams {
  Start: [number, number, number];
  End: [number, number, number];
  BoundaryCondition?: StructuralBoundaryEdgeConditionParams;
  /** IFC4 only. The connection's local z direction, in storey coordinates like
   *  `Start`/`End`; must not be parallel to the edge. Defaults to storey up
   *  (+Z), or +X for an edge within about 2.5 degrees of vertical. */
  Axis?: Point3D;
  /** IFC4X3 only; same meaning and default as `Axis`. */
  AxisDirection?: Point3D;
  Name?: string;
  Description?: string;
  ObjectType?: string;
  /** Explicit GlobalId (22-char IFC GUID); generated when omitted. */
  GlobalId?: string;
}

/** IDs in the exclusively owned edge subgraph. */
export interface StructuralCurveConnectionBuildResult {
  connectionId: number;
  boundaryConditionId?: number;
  placementId: number;
  /** Absent on IFC2X3, which has no axis attribute. */
  axisDirectionId?: number;
  point1Id: number;
  point2Id: number;
  vertex1Id: number;
  vertex2Id: number;
  edgeId: number;
  topologyRepId: number;
  productShapeId: number;
}

export function addStructuralCurveConnectionToStore(
  editor: StoreEditor,
  anchor: SpatialAnchor,
  params: StructuralCurveConnectionInStoreParams,
): StructuralCurveConnectionBuildResult {
  assertStructuralBuilderSchema(anchor);
  const schema = anchor.schema ?? 'IFC4';
  if (params.Axis && schema !== 'IFC4') throw new Error('Axis exists only in IFC4; IFC4X3 uses AxisDirection and IFC2X3 has neither');
  if (params.AxisDirection && schema !== 'IFC4X3') throw new Error('AxisDirection exists only in IFC4X3');
  const given = params.Axis ?? params.AxisDirection;
  assertFinitePoint3({ Start: params.Start, End: params.End }, 'addStructuralCurveConnectionToStore');
  if (given) assertFinitePoint3({ Axis: given }, 'addStructuralCurveConnectionToStore');
  const bc = params.BoundaryCondition;
  const stiffness = (['TranslationalStiffnessByLengthX', 'TranslationalStiffnessByLengthY', 'TranslationalStiffnessByLengthZ',
    'RotationalStiffnessByLengthX', 'RotationalStiffnessByLengthY', 'RotationalStiffnessByLengthZ'] as const)
    .map((key) => structuralStiffness(anchor, bc?.[key], key.startsWith('Translational') ? 'IfcModulusOfLinearSubgradeReactionMeasure' : 'IfcModulusOfRotationalSubgradeReactionMeasure', `addStructuralCurveConnectionToStore: ${key}`));
  // The frame rule is linearProfileFrame's, kept local: this builder loads lazily
  // (#9668), and sharing that module with the eager beam builders would carve it
  // into its own startup chunk.
  const start = toNativePoint3(anchor, params.Start), end = toNativePoint3(anchor, params.End);
  const delta: Point3D = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
  const length = Math.hypot(...delta);
  if (!(length > 0)) throw new Error('addStructuralCurveConnectionToStore: Start and End must be distinct points');
  const along = vecNorm(delta);
  const u = vecNorm(vecCross(Math.abs(along[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], along));
  const v = vecCross(along, u);
  const dot = (a: Point3D, b: Point3D) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // The axis defines the connection's local z, so it must not run along the
  // edge. IFC reads it in the placement frame (Z along the edge, X = u).
  const world: Point3D = given ?? (Math.abs(along[2]) > 0.999 ? [1, 0, 0] : [0, 0, 1]);
  // Within about 0.06 degrees of the edge, the local y = z x x is numerically meaningless.
  // Written so NaN (a malformed axis from an untyped caller) also fails.
  if (!(world.length === 3 && vecLen(vecCross(world, along)) > 1e-3 * vecLen(world))) {
    throw new Error('addStructuralCurveConnectionToStore: Axis must be nonzero and not parallel to the edge');
  }
  const axis = vecNorm([dot(u, world), dot(v, world), dot(along, world)]);
  const globalId = productGuid(params, anchor.guidRandom); // validated before anything is written

  const placementId = emitLocalPlacement(editor, anchor.storeyPlacementId, start, along, u);
  const axisDirectionId = schema === 'IFC2X3' ? undefined : editor.addEntity('IfcDirection', [axis]).expressId;
  const point1Id = editor.addEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId;
  const point2Id = editor.addEntity('IfcCartesianPoint', [[0, 0, length]]).expressId;
  const vertex1Id = editor.addEntity('IfcVertexPoint', [`#${point1Id}`]).expressId;
  const vertex2Id = editor.addEntity('IfcVertexPoint', [`#${point2Id}`]).expressId;
  const edgeId = editor.addEntity('IfcEdge', [`#${vertex1Id}`, `#${vertex2Id}`]).expressId;
  const topologyRepId = editor.addEntity('IfcTopologyRepresentation', [`#${anchor.axisContextId}`, 'Axis', 'Edge', [`#${edgeId}`]]).expressId;
  const productShapeId = editor.addEntity('IfcProductDefinitionShape', [null, null, [`#${topologyRepId}`]]).expressId;

  const boundaryConditionId = bc ? editor.addEntity('IfcBoundaryEdgeCondition', [bc.Name ?? null, ...stiffness]).expressId : undefined;
  const connectionId = editor.addEntity('IfcStructuralCurveConnection', [
    globalId,
    ownerHistoryRef(anchor.ownerHistoryId),
    params.Name ?? 'Structural Curve Connection',
    params.Description ?? null,
    params.ObjectType ?? null,
    `#${placementId}`,
    `#${productShapeId}`,
    boundaryConditionId === undefined ? null : `#${boundaryConditionId}`,
    ...(axisDirectionId === undefined ? [] : [`#${axisDirectionId}`]), // Axis (IFC4) / AxisDirection (IFC4X3)
  ]).expressId;

  return { connectionId, boundaryConditionId, placementId, axisDirectionId, point1Id, point2Id, vertex1Id, vertex2Id, edgeId, topologyRepId, productShapeId };
}
