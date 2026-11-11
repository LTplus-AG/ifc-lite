/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { Point3D } from '../types.js';
import { toNativeLength, type SpatialAnchor } from './anchor.js';
import { assertPositiveFinite, ownerHistoryRef, productGuid } from './_emit-helpers.js';
import { prepareStructuralFace, emitStructuralFace, type StructuralFaceIds } from './_structural-face.js';
import { assertStructuralBuilderSchema } from './_structural-stiffness.js';

export type StructuralSurfaceMemberType = 'BENDING_ELEMENT' | 'MEMBRANE_ELEMENT' | 'SHELL' | 'USERDEFINED' | 'NOTDEFINED';
export interface StructuralSurfaceMemberInStoreParams {
  Boundary: Point3D[];
  PredefinedType?: StructuralSurfaceMemberType;
  Thickness?: number;
  Name?: string;
  Description?: string;
  ObjectType?: string;
  GlobalId?: string;
}
export interface StructuralSurfaceMemberBuildResult extends StructuralFaceIds { memberId: number }

/** Planar analytical surface, owned by this member, anchored to a storey. */
export function addStructuralSurfaceMemberToStore(editor: StoreEditor, anchor: SpatialAnchor, params: StructuralSurfaceMemberInStoreParams): StructuralSurfaceMemberBuildResult {
  assertStructuralBuilderSchema(anchor);
  const type = params.PredefinedType ?? 'NOTDEFINED';
  if (type === 'USERDEFINED' && !params.ObjectType) throw new Error('addStructuralSurfaceMemberToStore: ObjectType is required when PredefinedType is USERDEFINED');
  if (params.Thickness !== undefined) assertPositiveFinite([params.Thickness], 'addStructuralSurfaceMemberToStore: Thickness must be finite and positive');
  const face = prepareStructuralFace(params.Boundary);
  const thickness = params.Thickness === undefined ? null : toNativeLength(anchor, params.Thickness);
  const result = emitStructuralFace(editor, anchor, face);
  const memberId = editor.addEntity('IfcStructuralSurfaceMember', [
    productGuid(params, anchor.guidRandom), ownerHistoryRef(anchor.ownerHistoryId), params.Name ?? 'Structural Surface Member',
    params.Description ?? null, params.ObjectType ?? null, `#${result.placementId}`, `#${result.productShapeId}`, `.${type}.`, thickness,
  ]).expressId;
  return { memberId, ...result };
}
