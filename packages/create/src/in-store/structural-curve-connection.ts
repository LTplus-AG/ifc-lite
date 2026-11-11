/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { assertStructuralBuilderSchema, structuralStiffness } from './_structural-stiffness.js';
import type { StoreEditor } from '@ifc-lite/mutations';
import { vecCross, vecNorm, assertFinitePoint3 } from '../ifc-creator-math.js';
import type { Point3D } from '../types.js';
import { toNativePoint3, type SpatialAnchor } from './anchor.js';
import { emitLocalPlacement, ownerHistoryRef, productGuid } from './_emit-helpers.js';

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
  axisDirectionId: number;
  point1Id: number;
  point2Id: number;
  vertex1Id: number;
  vertex2Id: number;
  edgeId: number;
  topologyRepId: number;
  productShapeId: number;
}

function computeRefDirection(axis: Point3D): Point3D {
  const up: Point3D = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  return vecNorm(vecCross(up, axis));
}

export function addStructuralCurveConnectionToStore(
  editor: StoreEditor,
  anchor: SpatialAnchor,
  params: StructuralCurveConnectionInStoreParams,
): StructuralCurveConnectionBuildResult {
  assertStructuralBuilderSchema(anchor);
  if (params.Axis && anchor.schema !== undefined && anchor.schema !== 'IFC4') throw new Error('Axis exists only in IFC4; IFC4X3 uses AxisDirection and IFC2X3 has neither');
  if (params.AxisDirection && anchor.schema !== 'IFC4X3') throw new Error('AxisDirection exists only in IFC4X3');
  // The placement's local Z runs along the edge, and the axis defines the
  // connection's local z, so it must not be parallel to the edge. The default,
  // local Y, is perpendicular to the edge and points up for non-vertical edges.
  const axis = params.Axis ?? params.AxisDirection ?? [0, 1, 0];
  assertFinitePoint3({ Axis: axis }, 'addStructuralCurveConnectionToStore');
  if (Math.hypot(axis[0], axis[1]) <= 1e-9 * Math.hypot(...axis)) throw new Error('Axis direction must be nonzero and not parallel to the edge (local Z)');
  const bc = params.BoundaryCondition;
  const stiffness = [bc?.TranslationalStiffnessByLengthX, bc?.TranslationalStiffnessByLengthY, bc?.TranslationalStiffnessByLengthZ,
    bc?.RotationalStiffnessByLengthX, bc?.RotationalStiffnessByLengthY, bc?.RotationalStiffnessByLengthZ]
    .map((v, i) => structuralStiffness(anchor, v, i < 3 ? 'IfcModulusOfLinearSubgradeReactionMeasure' : 'IfcModulusOfRotationalSubgradeReactionMeasure'));
  assertFinitePoint3({ Start: params.Start, End: params.End }, 'addStructuralCurveConnectionToStore');
  params = {
    ...params,
    Start: toNativePoint3(anchor, params.Start),
    End: toNativePoint3(anchor, params.End),
  };
  const dx = params.End[0] - params.Start[0];
  const dy = params.End[1] - params.Start[1];
  const dz = params.End[2] - params.Start[2];
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (length <= 0) {
    throw new Error('addStructuralCurveConnectionToStore: Start and End must be distinct points');
  }
  const dir: Point3D = vecNorm([dx, dy, dz]);
  const refDir = computeRefDirection(dir);

  const placementId = emitLocalPlacement(editor, anchor.storeyPlacementId, params.Start, dir, refDir);

  const axisDirectionId = editor.addEntity('IfcDirection', [axis]).expressId;

  const pt1Id = editor.addEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId;
  const pt2Id = editor.addEntity('IfcCartesianPoint', [[0, 0, length]]).expressId;
  const vertex1Id = editor.addEntity('IfcVertexPoint', [`#${pt1Id}`]).expressId;
  const vertex2Id = editor.addEntity('IfcVertexPoint', [`#${pt2Id}`]).expressId;
  const edgeId = editor.addEntity('IfcEdge', [`#${vertex1Id}`, `#${vertex2Id}`]).expressId;
  const topologyRepId = editor.addEntity('IfcTopologyRepresentation', [
    `#${anchor.axisContextId}`,
    'Axis',
    'Edge',
    [`#${edgeId}`],
  ]).expressId;
  const productShapeId = editor.addEntity('IfcProductDefinitionShape', [
    null,
    null,
    [`#${topologyRepId}`],
  ]).expressId;

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
    ...(anchor.schema === 'IFC2X3' ? [] : [`#${axisDirectionId}`]), // Axis (IFC4+)
  ]).expressId;

  return {
    connectionId,
    boundaryConditionId,
    placementId,
    axisDirectionId,
    point1Id: pt1Id,
    point2Id: pt2Id,
    vertex1Id,
    vertex2Id,
    edgeId,
    topologyRepId,
    productShapeId,
  };
}
