/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchored builder for IfcMember — a generic structural member
 * (brace, strut, post). Geometry shape mirrors `addBeamToStore`:
 *   - placement origin at `Start`, local Z = member axis
 *   - cross-section centred on the axis, extruded by member length
 * The distinction is the IFC type and the `.NOTDEFINED.` PredefinedType
 * default — IfcBeam carries `.BEAM.`.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import { vecCross, vecNorm } from '../ifc-creator-math.js';
import type { Point3D } from '../types.js';
import type { SpatialAnchor } from './anchor.js';
import {
  emitBodyRepresentation,
  emitExtrudedSolid,
  emitLocalPlacement,
  emitRectangleProfile,
  emitRelContainedInSpatialStructure,
  ifcElementHeader,
} from './_emit-helpers.js';

export interface MemberInStoreParams {
  Start: [number, number, number];
  End: [number, number, number];
  Width: number;
  Height: number;
  PredefinedType?:
    | 'BRACE' | 'CHORD' | 'COLLAR' | 'MEMBER' | 'MULLION' | 'PLATE'
    | 'POST' | 'PURLIN' | 'RAFTER' | 'STRINGER' | 'STRUT' | 'STUD'
    | 'USERDEFINED' | 'NOTDEFINED';
  Name?: string;
  Description?: string;
  ObjectType?: string;
  Tag?: string;
}

export interface MemberBuildResult {
  memberId: number;
  placementId: number;
  profileId: number;
  solidId: number;
  shapeRepId: number;
  productShapeId: number;
  relContainedId: number;
}

function computeRefDirection(axis: Point3D): Point3D {
  const up: Point3D = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  return vecNorm(vecCross(up, axis));
}

export function addMemberToStore(
  editor: StoreEditor,
  anchor: SpatialAnchor,
  params: MemberInStoreParams,
): MemberBuildResult {
  const dx = params.End[0] - params.Start[0];
  const dy = params.End[1] - params.Start[1];
  const dz = params.End[2] - params.Start[2];
  const memberLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (memberLen <= 0) {
    throw new Error('addMemberToStore: Start and End must be distinct points');
  }
  if (params.Width <= 0 || params.Height <= 0) {
    throw new Error('addMemberToStore: Width and Height must be positive');
  }
  const dir: Point3D = vecNorm([dx, dy, dz]);
  const refDir = computeRefDirection(dir);

  const placementId = emitLocalPlacement(editor, anchor.storeyPlacementId, params.Start, dir, refDir);
  const profileId = emitRectangleProfile(editor, params.Width, params.Height);
  const solidId = emitExtrudedSolid(editor, profileId, memberLen);
  const { shapeRepId, productShapeId } = emitBodyRepresentation(editor, anchor.bodyContextId, solidId);

  const attrs = ifcElementHeader(anchor.ownerHistoryId, placementId, productShapeId, params, 'Member');
  if ((anchor.schema ?? 'IFC4') !== 'IFC2X3') {
    attrs.push(`.${params.PredefinedType ?? 'NOTDEFINED'}.`);
  }
  const memberId = editor.addEntity('IfcMember', attrs as Parameters<StoreEditor['addEntity']>[1]).expressId;
  const relContainedId = emitRelContainedInSpatialStructure(editor, anchor.ownerHistoryId, memberId, anchor.storeyId);

  return { memberId, placementId, profileId, solidId, shapeRepId, productShapeId, relContainedId };
}
