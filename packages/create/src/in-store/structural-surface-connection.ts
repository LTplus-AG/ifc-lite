/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { Point3D } from '../types.js';
import type { SpatialAnchor } from './anchor.js';
import { ownerHistoryRef, productGuid } from './_emit-helpers.js';
import { prepareStructuralFace, emitStructuralFace } from './_structural-face.js';
import { assertStructuralBuilderSchema, structuralStiffness } from './_structural-stiffness.js';

export interface StructuralBoundaryFaceConditionParams {
  Name?: string;
  TranslationalStiffnessByAreaX?: boolean | number;
  TranslationalStiffnessByAreaY?: boolean | number;
  TranslationalStiffnessByAreaZ?: boolean | number;
}
export interface StructuralSurfaceConnectionInStoreParams {
  Boundary: Point3D[];
  Name?: string;
  Description?: string;
  ObjectType?: string;
  GlobalId?: string;
  BoundaryCondition?: StructuralBoundaryFaceConditionParams;
}
export interface StructuralSurfaceConnectionBuildResult extends ReturnType<typeof emitStructuralFace> {
  connectionId: number;
  boundaryConditionId?: number;
}

export function addStructuralSurfaceConnectionToStore(editor: StoreEditor, anchor: SpatialAnchor, params: StructuralSurfaceConnectionInStoreParams): StructuralSurfaceConnectionBuildResult {
  assertStructuralBuilderSchema(anchor);
  const face = prepareStructuralFace(params.Boundary);
  const bc = params.BoundaryCondition;
  const stiffness = [bc?.TranslationalStiffnessByAreaX, bc?.TranslationalStiffnessByAreaY, bc?.TranslationalStiffnessByAreaZ]
    .map(v => structuralStiffness(anchor, v, 'IfcModulusOfSubgradeReactionMeasure'));
  const result = emitStructuralFace(editor, anchor, face);
  const boundaryConditionId = bc ? editor.addEntity('IfcBoundaryFaceCondition', [bc.Name ?? null, ...stiffness]).expressId : undefined;
  const connectionId = editor.addEntity('IfcStructuralSurfaceConnection', [
    productGuid(params, anchor.guidRandom), ownerHistoryRef(anchor.ownerHistoryId), params.Name ?? 'Structural Surface Connection',
    params.Description ?? null, params.ObjectType ?? null, `#${result.placementId}`, `#${result.productShapeId}`, boundaryConditionId === undefined ? null : `#${boundaryConditionId}`,
  ]).expressId;
  return { connectionId, boundaryConditionId, ...result };
}
