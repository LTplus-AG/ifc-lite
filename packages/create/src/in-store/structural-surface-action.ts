/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Constant surface actions own their load; location comes from IfcRelConnectsStructuralActivity.
 * IFC2X3 has only PlanarAction, with required DestabilizingLoad and CausedBy before ProjectedOrTrue.
 * IFC4+ PlanarAction constrains SurfaceAction to CONST. Both forms are offered explicitly.
 */
import type { StoreEditor } from '@ifc-lite/mutations';
import { assertActivitySchema, assertAppliedLoad, assertEnum, assertBoolean, emitActivity, validateLoad, type ActivityAnchor, type ActivityParams, type ActivityResult } from './_structural-activity.js';

export interface StructuralPlanarForceParams { Name?: string; PlanarForceX?: number; PlanarForceY?: number; PlanarForceZ?: number }
/** Temperature parameters use IFC4 EXPRESS names on every target.
 * On IFC2X3, DeltaTConstant, DeltaTY and DeltaTZ write the corresponding
 * DeltaT_Constant, DeltaT_Y and DeltaT_Z slots without changing their values.
 */
export interface StructuralTemperatureParams { Name?: string; DeltaTConstant?: number; DeltaTY?: number; DeltaTZ?: number }
export type StructuralSurfaceLoad =
  | ({ Type: 'IfcStructuralLoadPlanarForce' } & StructuralPlanarForceParams)
  | ({ Type: 'IfcStructuralLoadTemperature' } & StructuralTemperatureParams);
export interface StructuralSurfaceActionInStoreParams extends ActivityParams {
  AppliedLoad: StructuralSurfaceLoad;
  DestabilizingLoad?: boolean;
  ProjectedOrTrue?: 'PROJECTED_LENGTH' | 'TRUE_LENGTH';
}
export type StructuralSurfaceActionBuildResult = ActivityResult;

export function addStructuralSurfaceActionToStore(editor: StoreEditor, anchor: ActivityAnchor, params: StructuralSurfaceActionInStoreParams): StructuralSurfaceActionBuildResult {
  assertActivitySchema(anchor, 'addStructuralSurfaceActionToStore', true);
  return surfaceAction(editor, anchor, params, 'IfcStructuralSurfaceAction');
}
export function addStructuralPlanarActionToStore(editor: StoreEditor, anchor: ActivityAnchor, params: StructuralSurfaceActionInStoreParams): StructuralSurfaceActionBuildResult {
  assertActivitySchema(anchor, 'addStructuralPlanarActionToStore');
  return surfaceAction(editor, anchor, params, 'IfcStructuralPlanarAction');
}
function surfaceAction(editor: StoreEditor, anchor: ActivityAnchor, params: StructuralSurfaceActionInStoreParams, type: string): ActivityResult {
  const builder = `add${type.slice(3)}ToStore`;
  assertAppliedLoad(builder, params.AppliedLoad);
  assertBoolean(builder, 'DestabilizingLoad', params.DestabilizingLoad);
  assertEnum(builder, 'ProjectedOrTrue', params.ProjectedOrTrue, ['PROJECTED_LENGTH', 'TRUE_LENGTH']);
  const fields = params.AppliedLoad.Type === 'IfcStructuralLoadPlanarForce'
    ? ['PlanarForceX', 'PlanarForceY', 'PlanarForceZ']
    : params.AppliedLoad.Type === 'IfcStructuralLoadTemperature' ? ['DeltaTConstant', 'DeltaTY', 'DeltaTZ'] : null;
  if (!fields) throw new Error(`${builder}: unsupported AppliedLoad.Type`);
  validateLoad(builder, params.AppliedLoad, fields);
  if (params.ProjectedOrTrue === 'PROJECTED_LENGTH' && params.GlobalOrLocal === 'LOCAL_COORDS') {
    throw new Error(`${builder}: PROJECTED_LENGTH requires GLOBAL_COORDS`);
  }
  const projected = `.${params.ProjectedOrTrue ?? 'TRUE_LENGTH'}.`;
  return emitActivity(editor, anchor, params, type, params.AppliedLoad.Type, params.AppliedLoad, fields,
    anchor.schema === 'IFC2X3' ? [params.DestabilizingLoad ?? false, null, projected]
      : [params.DestabilizingLoad ?? null, projected, '.CONST.']);
}
