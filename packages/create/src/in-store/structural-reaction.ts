/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Reactions own a constant load/result. Connect them to an item with the existing relationship builder. */
import type { StoreEditor } from '@ifc-lite/mutations';
import { assertActivitySchema, assertAppliedLoad, emitActivity, validateLoad, type ActivityAnchor, type ActivityParams, type ActivityResult } from './_structural-activity.js';
import type { StructuralPlanarForceParams } from './structural-surface-action.js';

export interface StructuralSingleForceParams { Name?: string; ForceX?: number; ForceY?: number; ForceZ?: number; MomentX?: number; MomentY?: number; MomentZ?: number }
export interface StructuralSingleDisplacementParams {
  Name?: string; DisplacementX?: number; DisplacementY?: number; DisplacementZ?: number;
  RotationalDisplacementRX?: number; RotationalDisplacementRY?: number; RotationalDisplacementRZ?: number;
}
export interface StructuralLinearForceParams {
  Name?: string; LinearForceX?: number; LinearForceY?: number; LinearForceZ?: number;
  LinearMomentX?: number; LinearMomentY?: number; LinearMomentZ?: number;
}
export interface StructuralPointReactionInStoreParams extends ActivityParams {
  AppliedLoad: ({ Type: 'IfcStructuralLoadSingleForce' } & StructuralSingleForceParams)
    | ({ Type: 'IfcStructuralLoadSingleDisplacement' } & StructuralSingleDisplacementParams);
}
export interface StructuralCurveReactionInStoreParams extends ActivityParams { AppliedLoad: StructuralLinearForceParams }
export interface StructuralSurfaceReactionInStoreParams extends ActivityParams { AppliedLoad: StructuralPlanarForceParams }
export type StructuralReactionBuildResult = ActivityResult;

export function addStructuralPointReactionToStore(editor: StoreEditor, anchor: ActivityAnchor, params: StructuralPointReactionInStoreParams): StructuralReactionBuildResult {
  const builder = 'addStructuralPointReactionToStore';
  assertActivitySchema(anchor, builder);
  assertAppliedLoad(builder, params.AppliedLoad);
  const fields = params.AppliedLoad.Type === 'IfcStructuralLoadSingleForce' ? ['ForceX', 'ForceY', 'ForceZ', 'MomentX', 'MomentY', 'MomentZ']
    : params.AppliedLoad.Type === 'IfcStructuralLoadSingleDisplacement' ? ['DisplacementX', 'DisplacementY', 'DisplacementZ', 'RotationalDisplacementRX', 'RotationalDisplacementRY', 'RotationalDisplacementRZ'] : null;
  if (!fields) throw new Error(`${builder}: unsupported AppliedLoad.Type`);
  validateLoad(builder, params.AppliedLoad, fields);
  return emitActivity(editor, anchor, params, 'IfcStructuralPointReaction', params.AppliedLoad.Type, params.AppliedLoad, fields, []);
}
export function addStructuralCurveReactionToStore(editor: StoreEditor, anchor: ActivityAnchor, params: StructuralCurveReactionInStoreParams): StructuralReactionBuildResult {
  const builder = 'addStructuralCurveReactionToStore';
  assertActivitySchema(anchor, builder, true);
  const fields = ['LinearForceX', 'LinearForceY', 'LinearForceZ', 'LinearMomentX', 'LinearMomentY', 'LinearMomentZ'];
  validateLoad(builder, params.AppliedLoad, fields);
  return emitActivity(editor, anchor, params, 'IfcStructuralCurveReaction', 'IfcStructuralLoadLinearForce', params.AppliedLoad, fields, ['.CONST.']);
}
export function addStructuralSurfaceReactionToStore(editor: StoreEditor, anchor: ActivityAnchor, params: StructuralSurfaceReactionInStoreParams): StructuralReactionBuildResult {
  const builder = 'addStructuralSurfaceReactionToStore';
  assertActivitySchema(anchor, builder, true);
  const fields = ['PlanarForceX', 'PlanarForceY', 'PlanarForceZ'];
  validateLoad(builder, params.AppliedLoad, fields);
  return emitActivity(editor, anchor, params, 'IfcStructuralSurfaceReaction', 'IfcStructuralLoadPlanarForce', params.AppliedLoad, fields, ['.CONST.']);
}
