/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreEditor } from '@ifc-lite/mutations';
import { assertFinitePoint3, vecCross, vecDot, vecLen, vecNorm } from '../ifc-creator-math.js';
import type { Point3D } from '../types.js';
import { toNativePoint3, type SpatialAnchor } from './anchor.js';
import { emitLocalPlacement, ownerHistoryRef, productGuid } from './_emit-helpers.js';
import { linearProfileFrame } from './linear-profile-frame.js';
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
  const stiffness = [bc?.TranslationalStiffnessByLengthX, bc?.TranslationalStiffnessByLengthY, bc?.TranslationalStiffnessByLengthZ,
    bc?.RotationalStiffnessByLengthX, bc?.RotationalStiffnessByLengthY, bc?.RotationalStiffnessByLengthZ]
    .map((v, i) => structuralStiffness(anchor, v, i < 3 ? 'IfcModulusOfLinearSubgradeReactionMeasure' : 'IfcModulusOfRotationalSubgradeReactionMeasure'));
  const frame = linearProfileFrame(toNativePoint3(anchor, params.Start), toNativePoint3(anchor, params.End));
  // The axis defines the connection's local z, so it must not run along the
  // edge. IFC reads it in the placement frame (Z along the edge, X = frame.u).
  const world: Point3D = given ?? (Math.abs(frame.along[2]) > 0.999 ? [1, 0, 0] : [0, 0, 1]);
  // Within about 0.06 degrees of the edge, the local y = z x x is numerically meaningless.
  // Written so NaN (a malformed axis from an untyped caller) also fails.
  if (!(world.length === 3 && vecLen(vecCross(world, frame.along)) > 1e-3 * vecLen(world))) {
    throw new Error('addStructuralCurveConnectionToStore: Axis must be nonzero and not parallel to the edge');
  }
  const axis = vecNorm([vecDot(frame.u, world), vecDot(frame.v, world), vecDot(frame.along, world)]);
  const globalId = productGuid(params, anchor.guidRandom); // validated before anything is written

  const placementId = emitLocalPlacement(editor, anchor.storeyPlacementId, frame.origin, frame.along, frame.u);
  const axisDirectionId = schema === 'IFC2X3' ? undefined : editor.addEntity('IfcDirection', [axis]).expressId;
  const point1Id = editor.addEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId;
  const point2Id = editor.addEntity('IfcCartesianPoint', [[0, 0, frame.length]]).expressId;
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
