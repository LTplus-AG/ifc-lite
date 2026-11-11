/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreEditor } from '@ifc-lite/mutations';
import { assertActivitySchema, assertEnum, assertBoolean, type ActivityAnchor } from './_structural-activity.js';
import { ownerHistoryRef, productGuid } from './_emit-helpers.js';
import { assignToStructuralGroupInStore } from './structural-relationships.js';

export interface StructuralResultGroupInStoreParams {
  GlobalId?: string;
  Name?: string;
  Description?: string;
  ObjectType?: string;
  TheoryType: 'FIRST_ORDER_THEORY' | 'SECOND_ORDER_THEORY' | 'THIRD_ORDER_THEORY' | 'FULL_NONLINEAR_THEORY' | 'USERDEFINED' | 'NOTDEFINED';
  ResultForLoadGroup: number;
  IsLinear: boolean;
  /** All reactions assigned in one relationship, including in IFC2X3. */
  ReactionIds: readonly number[];
}
export interface StructuralResultGroupBuildResult { resultGroupId: number; assignmentId: number }

export function addStructuralResultGroupToStore(editor: StoreEditor, anchor: ActivityAnchor, params: StructuralResultGroupInStoreParams): StructuralResultGroupBuildResult {
  const builder = 'addStructuralResultGroupToStore';
  assertActivitySchema(anchor, builder);
  assertEnum(builder, 'TheoryType', params.TheoryType, ['FIRST_ORDER_THEORY', 'SECOND_ORDER_THEORY', 'THIRD_ORDER_THEORY', 'FULL_NONLINEAR_THEORY', 'USERDEFINED', 'NOTDEFINED'], false);
  assertBoolean(builder, 'IsLinear', params.IsLinear, false);
  if (params.TheoryType === 'USERDEFINED' && !params.ObjectType) throw new Error(`${builder}: USERDEFINED requires ObjectType`);
  if (!Number.isSafeInteger(params.ResultForLoadGroup) || params.ResultForLoadGroup <= 0
    || params.ReactionIds.length === 0 || params.ReactionIds.some(id => !Number.isSafeInteger(id) || id <= 0)
    || new Set(params.ReactionIds).size !== params.ReactionIds.length) {
    throw new Error(`${builder}: supply a positive ResultForLoadGroup and non-empty distinct ReactionIds`);
  }
  if (!['IfcStructuralLoadGroup', 'IfcStructuralLoadCase'].includes(editor.getEntityType(params.ResultForLoadGroup) ?? '')) {
    throw new Error(`${builder}: ResultForLoadGroup must reference a structural load group`);
  }
  if (params.ReactionIds.some(id => !['IfcStructuralPointReaction', 'IfcStructuralCurveReaction', 'IfcStructuralSurfaceReaction'].includes(editor.getEntityType(id) ?? ''))) {
    throw new Error(`${builder}: ReactionIds must reference structural reactions`);
  }
  const resultGroupId = editor.addEntity('IfcStructuralResultGroup', [productGuid(params, anchor.guidRandom),
    ownerHistoryRef(anchor.ownerHistoryId), params.Name ?? 'Result Group', params.Description ?? null, params.ObjectType ?? null,
    `.${params.TheoryType}.`, `#${params.ResultForLoadGroup}`, params.IsLinear]).expressId;
  const assignmentId = assignToStructuralGroupInStore(editor, anchor.ownerHistoryId, resultGroupId, params.ReactionIds, anchor.guidRandom);
  return { resultGroupId, assignmentId };
}
