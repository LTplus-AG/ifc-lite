/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchored builder for `IfcStructuralCurveMember` — a straight analytical
 * line member (beam/column/brace idealisation) between `Start` and `End`
 * (#5167 task S.1).
 *
 * Schema targeted: IFC4 (IFC4_ADD2_TC1.exp), verified against the generated
 * IFC4 registry's `allAttributes` for `IfcStructuralCurveMember`:
 *   `GlobalId, OwnerHistory?, Name?, Description?, ObjectType?,
 *    ObjectPlacement?, Representation?, PredefinedType, Axis`
 * `PredefinedType` (`IfcStructuralCurveMemberTypeEnum`) and `Axis`
 * (`IfcDirection`, mandatory — NOT an inline list) are both own attributes
 * of this entity, not inherited. IFC2X3 has no `Axis`, so it is left out
 * there.
 *
 * The placement and topology representation are owned by this member. Shared
 * model contexts and the parent storey placement are references, never owned.
 * `removeStructuralEntityInStore` reclaims the owned subgraph only when no
 * surviving entity references it. IFC2X3 has no Axis attribute, so no detached
 * axis direction is emitted there.
 *
 * Pure: no I/O, no parser access — operates entirely through the editor.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import { vecCross, vecNorm, assertFinitePoint3 } from '../ifc-creator-math.js';
import type { Point3D } from '../types.js';
import { toNativePoint3, type SpatialAnchor } from './anchor.js';
import { emitLocalPlacement, ownerHistoryRef, productGuid } from './_emit-helpers.js';

export type StructuralCurveMemberType =
  | 'RIGID_JOINED_MEMBER' | 'PIN_JOINED_MEMBER' | 'CABLE' | 'TENSION_MEMBER'
  | 'COMPRESSION_MEMBER' | 'USERDEFINED' | 'NOTDEFINED';

export interface StructuralCurveMemberInStoreParams {
  Start: [number, number, number];
  End: [number, number, number];
  PredefinedType?: StructuralCurveMemberType;
  Name?: string;
  Description?: string;
  /** Required by the EXPRESS `HasObjectType` WHERE rule when `PredefinedType` is `'USERDEFINED'`. */
  ObjectType?: string;
  /** Explicit GlobalId (22-char IFC GUID); generated when omitted. */
  GlobalId?: string;
}

/** Every expressId this builder emits — the member's full owned sub-graph (see removal note above). */
export interface StructuralCurveMemberBuildResult {
  memberId: number;
  placementId: number;
  /** Absent in IFC2X3, which has no Axis attribute. */
  axisDirectionId?: number;
  /** The `IfcCartesianPoint` each `IfcVertexPoint` below is built on. Exposed
   *  because they are owned too: a cascade delete driven by this result would
   *  otherwise orphan both points (#5167 review). */
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

export function addStructuralCurveMemberToStore(
  editor: StoreEditor,
  anchor: SpatialAnchor,
  params: StructuralCurveMemberInStoreParams,
): StructuralCurveMemberBuildResult {
  const predefinedType = params.PredefinedType ?? 'NOTDEFINED';
  if (predefinedType === 'USERDEFINED' && !params.ObjectType) {
    throw new Error('addStructuralCurveMemberToStore: ObjectType is required when PredefinedType is USERDEFINED');
  }

  assertFinitePoint3({ Start: params.Start, End: params.End }, 'addStructuralCurveMemberToStore');
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
    throw new Error('addStructuralCurveMemberToStore: Start and End must be distinct points');
  }
  const dir: Point3D = vecNorm([dx, dy, dz]);
  const refDir = computeRefDirection(dir);

  // Placement at Start, local Z along the member axis (mirrors addBeamToStore).
  const placementId = emitLocalPlacement(editor, anchor.storeyPlacementId, params.Start, dir, refDir);

  // `IfcStructuralCurveMember.Axis` is expressed in the placement's LOCAL
  // frame, and the placement's own local Z is already the member direction
  // (set above), so the member's local axis is always world +Z here.
  const axisDirectionId = anchor.schema === 'IFC2X3'
    ? undefined
    : editor.addEntity('IfcDirection', [[0, 0, 1]]).expressId;

  // Topology geometry: an edge from the local origin to (0, 0, length) —
  // `length` is already in the file's native unit (Start/End were converted
  // above) — wholly owned by this member (see module doc).
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

  const memberId = editor.addEntity('IfcStructuralCurveMember', [
    productGuid(params, anchor.guidRandom),
    ownerHistoryRef(anchor.ownerHistoryId),
    params.Name ?? 'Structural Curve Member',
    params.Description ?? null,
    params.ObjectType ?? null,
    `#${placementId}`,
    `#${productShapeId}`,
    `.${predefinedType}.`,
    ...(anchor.schema === 'IFC2X3' ? [] : [`#${axisDirectionId}`]), // Axis (IFC4+)
  ]).expressId;

  return {
    memberId,
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
