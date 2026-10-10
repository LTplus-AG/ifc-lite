/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchored builder for IfcMember — a generic structural member
 * (brace, strut, post). Geometry shape mirrors `addBeamToStore`:
 *   - placement origin at `Start`, local Z = member axis
 *   - cross-section (Width x Height rectangle, or a `Profile`) centred on
 *     the axis, extruded by member length
 * The distinction is the IFC type and the `.NOTDEFINED.` PredefinedType
 * default — IfcBeam carries `.BEAM.`.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import { assertFinitePoint3 } from '../ifc-creator-math.js';
import { linearProfileFrame } from './linear-profile-frame.js';
import { toNativeLength, toNativePoint3, type SpatialAnchor } from './anchor.js';
import {
  emitBodyRepresentation,
  emitExtrudedSolid,
  emitLocalPlacement,
  emitRectangleProfile,
  emitRelContainedInSpatialStructure,
  ifcElementHeader,
} from './_emit-helpers.js';
import { emitProfileSection, linearSection, type ProfileSection } from './profile.js';

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
  /** Explicit GlobalId (22-char IFC GUID); generated when omitted. */
  GlobalId?: string;
}

/** A member with a parameterised cross-section in place of the `Width` x `Height` rectangle. */
export interface ProfiledMemberInStoreParams extends Omit<MemberInStoreParams, 'Width' | 'Height'> {
  Profile: ProfileSection;
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


export function addMemberToStore(
  editor: StoreEditor,
  anchor: SpatialAnchor,
  params: MemberInStoreParams | ProfiledMemberInStoreParams,
): MemberBuildResult {
  // A non-finite Start/End coordinate makes the derived memberLen NaN, and
  // `NaN <= 0` is false, so the distinct-points check below never fires.
  // Validate the source coordinates instead of trusting the derived value.
  assertFinitePoint3({ Start: params.Start, End: params.End }, 'addMemberToStore');

  // Params are metres; convert dimensioned fields to the file's native
  // length unit before emit (see SpatialAnchor.lengthUnitScale).
  const start = toNativePoint3(anchor, params.Start);
  const end = toNativePoint3(anchor, params.End);
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const dz = end[2] - start[2];
  const memberLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (memberLen <= 0) {
    throw new Error('addMemberToStore: Start and End must be distinct points');
  }
  const section = linearSection(anchor, params, 'addMemberToStore');
  const { along: dir, u: refDir } = linearProfileFrame(start, end);

  const placementId = emitLocalPlacement(editor, anchor.storeyPlacementId, start, dir, refDir);
  const profileId = section.Profile
    ? emitProfileSection(editor, anchor, section.Profile, 'addMemberToStore')
    : emitRectangleProfile(editor, toNativeLength(anchor, section.Width), toNativeLength(anchor, section.Height));
  const solidId = emitExtrudedSolid(editor, profileId, memberLen);
  const { shapeRepId, productShapeId } = emitBodyRepresentation(editor, anchor.bodyContextId, solidId);

  const attrs = ifcElementHeader(anchor.ownerHistoryId, placementId, productShapeId, params, 'Member', anchor.guidRandom);
  if ((anchor.schema ?? 'IFC4') !== 'IFC2X3') {
    attrs.push(`.${params.PredefinedType ?? 'NOTDEFINED'}.`);
  }
  const memberId = editor.addEntity('IfcMember', attrs as Parameters<StoreEditor['addEntity']>[1]).expressId;
  const relContainedId = emitRelContainedInSpatialStructure(editor, anchor.ownerHistoryId, memberId, anchor.storeyId, anchor.guidRandom);

  return { memberId, placementId, profileId, solidId, shapeRepId, productShapeId, relContainedId };
}
