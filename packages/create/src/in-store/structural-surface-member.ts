/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { assertActivitySchema, assertEnum } from './_structural-activity.js';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { Point3D } from '../types.js';
import { toNativeLength, type SpatialAnchor } from './anchor.js';
import { assertPositiveFinite, ownerHistoryRef, productGuid } from './_emit-helpers.js';
import { prepareStructuralFace, emitStructuralFace, type StructuralFaceIds } from './_structural-face.js';
import { assertStructuralBuilderSchema } from './_structural-stiffness.js';

export type StructuralSurfaceMemberType = 'BENDING_ELEMENT' | 'MEMBRANE_ELEMENT' | 'SHELL' | 'USERDEFINED' | 'NOTDEFINED';
export interface StructuralSurfaceMemberInStoreParams {
  Boundary: Point3D[];
  Type?: 'IfcStructuralSurfaceMember' | 'IfcStructuralSurfaceMemberVarying';
  PredefinedType?: StructuralSurfaceMemberType;
  Thickness?: number;
  SubsequentThickness?: number[];
  VaryingThicknessLocation?: number;
  Name?: string;
  Description?: string;
  ObjectType?: string;
  GlobalId?: string;
}
export interface StructuralSurfaceMemberBuildResult extends StructuralFaceIds { memberId: number }

/** Planar analytical surface, owned by this member, anchored to a storey. */
export function addStructuralSurfaceMemberToStore(editor: StoreEditor, anchor: SpatialAnchor, params: StructuralSurfaceMemberInStoreParams): StructuralSurfaceMemberBuildResult {
  assertActivitySchema(anchor, 'addStructuralSurfaceMemberToStore');
  assertEnum('addStructuralSurfaceMemberToStore', 'Type', params.Type, ['IfcStructuralSurfaceMember', 'IfcStructuralSurfaceMemberVarying']);
  assertStructuralBuilderSchema(anchor);
  const type = params.PredefinedType ?? 'NOTDEFINED';
  if (type === 'USERDEFINED' && !params.ObjectType) throw new Error('addStructuralSurfaceMemberToStore: ObjectType is required when PredefinedType is USERDEFINED');
  // JSON callers send null for an unset Thickness.
  if (params.Thickness != null) assertPositiveFinite([params.Thickness], 'addStructuralSurfaceMemberToStore: Thickness must be finite and positive');
  const varying = params.Type === 'IfcStructuralSurfaceMemberVarying';
  if (!varying && (params.SubsequentThickness !== undefined || params.VaryingThicknessLocation !== undefined)) throw new Error('addStructuralSurfaceMemberToStore: thickness stations require IfcStructuralSurfaceMemberVarying');
  if (varying && anchor.schema === 'IFC2X3' && (params.Thickness == null || !params.SubsequentThickness || params.SubsequentThickness.length < 2 || !params.SubsequentThickness.every(v => Number.isFinite(v) && v > 0) || !params.VaryingThicknessLocation || editor.getEntityType(params.VaryingThicknessLocation) !== 'IfcShapeAspect')) throw new Error('addStructuralSurfaceMemberToStore: IFC2X3 varying requires Thickness, SubsequentThickness (at least two positive values) and VaryingThicknessLocation (IfcShapeAspect)');
  if (anchor.schema !== 'IFC2X3' && (params.SubsequentThickness !== undefined || params.VaryingThicknessLocation !== undefined)) throw new Error('addStructuralSurfaceMemberToStore: thickness stations exist only in IFC2X3');
  const face = prepareStructuralFace(params.Boundary);
  const globalId = productGuid(params, anchor.guidRandom); // validated before anything is written
  const thickness = params.Thickness == null ? null : toNativeLength(anchor, params.Thickness);
  const result = emitStructuralFace(editor, anchor, face);
  const attrs: Parameters<StoreEditor['addEntity']>[1] = [
    globalId, ownerHistoryRef(anchor.ownerHistoryId), params.Name ?? 'Structural Surface Member',
    params.Description ?? null, params.ObjectType ?? null, `#${result.placementId}`, `#${result.productShapeId}`, `.${type}.`, thickness,
    ...(varying && anchor.schema === 'IFC2X3' ? [params.SubsequentThickness!.map(v => ({ real: toNativeLength(anchor, v) })), `#${params.VaryingThicknessLocation}`] : []),
  ];
  const memberId = params.Type === 'IfcStructuralSurfaceMemberVarying'
    ? editor.addEntity('IfcStructuralSurfaceMemberVarying', attrs).expressId
    : editor.addEntity('IfcStructuralSurfaceMember', attrs).expressId;
  return { memberId, ...result };
}
