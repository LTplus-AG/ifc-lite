/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { conformsTo, schemaRegistry } from './schema-attributes.js';
import type { StoreEditor } from '@ifc-lite/mutations';
import { ownerHistoryRef, productGuid } from './_emit-helpers.js';
import { assertActivitySchema, assertBoolean, assertEnum, type ActivityAnchor, type ActivityParams } from './_structural-activity.js';

export interface StructuralCurveActionInStoreParams extends ActivityParams {
  AppliedLoad: number;
  PredefinedType?: 'CONST' | 'LINEAR' | 'POLYGONAL' | 'SINUS' | 'PARABOLA' | 'DISCRETE' | 'USERDEFINED' | 'NOTDEFINED';
  DestabilizingLoad?: boolean;
  ProjectedOrTrue?: 'PROJECTED_LENGTH' | 'TRUE_LENGTH';
}
/** General curve action borrowing an existing load or configuration. */
export function addStructuralCurveActionToStore(editor: StoreEditor, anchor: ActivityAnchor, params: StructuralCurveActionInStoreParams): number {
  const label = 'addStructuralCurveActionToStore';
  assertActivitySchema(anchor, label, true);
  assertEnum(label, 'PredefinedType', params.PredefinedType, ['CONST', 'LINEAR', 'POLYGONAL', 'SINUS', 'PARABOLA', 'DISCRETE', 'USERDEFINED', 'NOTDEFINED']);
  assertEnum(label, 'GlobalOrLocal', params.GlobalOrLocal, ['GLOBAL_COORDS', 'LOCAL_COORDS']);
  assertEnum(label, 'ProjectedOrTrue', params.ProjectedOrTrue, ['PROJECTED_LENGTH', 'TRUE_LENGTH']);
  assertBoolean(label, 'DestabilizingLoad', params.DestabilizingLoad);
  if (!conformsTo(schemaRegistry(anchor.schema, label), editor.getEntityType(params.AppliedLoad) ?? '', 'IfcStructuralLoad')) throw new Error(`${label}: AppliedLoad must reference an IfcStructuralLoad`);
  if (params.PredefinedType === 'USERDEFINED' && !params.ObjectType) throw new Error(`${label}: USERDEFINED requires ObjectType`);
  if (params.ProjectedOrTrue === 'PROJECTED_LENGTH' && params.GlobalOrLocal === 'LOCAL_COORDS') throw new Error(`${label}: PROJECTED_LENGTH requires GLOBAL_COORDS`);
  return editor.addEntity('IfcStructuralCurveAction', [productGuid(params, anchor.guidRandom), ownerHistoryRef(anchor.ownerHistoryId), params.Name ?? null, params.Description ?? null, params.ObjectType ?? null, null, null, `#${params.AppliedLoad}`, `.${params.GlobalOrLocal ?? 'GLOBAL_COORDS'}.`, params.DestabilizingLoad ?? null, params.ProjectedOrTrue ? `.${params.ProjectedOrTrue}.` : null, `.${params.PredefinedType ?? 'NOTDEFINED'}.`]).expressId;
}
