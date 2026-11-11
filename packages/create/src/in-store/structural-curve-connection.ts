/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreEditor } from '@ifc-lite/mutations';
import { assertFinitePoint3 } from '../ifc-creator-math.js';
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
  /** IFC4 only, direction in the connection's local frame, whose Z runs along
   *  the edge; must not be parallel to it. Defaults to local Y. */
  Axis?: Point3D;
  /** IFC4X3 only; same frame and default as `Axis`. */
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
  // The placement's local Z runs along the edge, and the axis defines the
  // connection's local z, so it must not be parallel to the edge. The default,
  // local Y, is perpendicular to the edge and points up for non-vertical edges.
  const axis = params.Axis ?? params.AxisDirection ?? [0, 1, 0];
  assertFinitePoint3({ Start: params.Start, End: params.End, Axis: axis }, 'addStructuralCurveConnectionToStore');
  if (Math.hypot(axis[0], axis[1]) <= 1e-9 * Math.hypot(...axis)) throw new Error('Axis direction must be nonzero and not parallel to the edge (local Z)');
  const bc = params.BoundaryCondition;
  const stiffness = [bc?.TranslationalStiffnessByLengthX, bc?.TranslationalStiffnessByLengthY, bc?.TranslationalStiffnessByLengthZ,
    bc?.RotationalStiffnessByLengthX, bc?.RotationalStiffnessByLengthY, bc?.RotationalStiffnessByLengthZ]
    .map((v, i) => structuralStiffness(anchor, v, i < 3 ? 'IfcModulusOfLinearSubgradeReactionMeasure' : 'IfcModulusOfRotationalSubgradeReactionMeasure'));
  const frame = linearProfileFrame(toNativePoint3(anchor, params.Start), toNativePoint3(anchor, params.End));

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
    productGuid(params, anchor.guidRandom),
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
