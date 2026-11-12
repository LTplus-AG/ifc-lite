/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { conformsTo, schemaRegistry } from './schema-attributes.js';
import type { IfcDataStore } from '@ifc-lite/parser';
import { structuralReferenceAttributes } from './_structural-reference.js';
import { asRef } from './style-entity-reader.js';
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
export function addStructuralCurveActionToStore(editor: StoreEditor, anchor: ActivityAnchor, params: StructuralCurveActionInStoreParams, store?: IfcDataStore): number {
  const label = 'addStructuralCurveActionToStore';
  assertActivitySchema(anchor, label, true);
  assertEnum(label, 'PredefinedType', params.PredefinedType, ['CONST', 'LINEAR', 'POLYGONAL', 'SINUS', 'PARABOLA', 'DISCRETE', 'USERDEFINED', 'NOTDEFINED']);
  assertEnum(label, 'GlobalOrLocal', params.GlobalOrLocal, ['GLOBAL_COORDS', 'LOCAL_COORDS']);
  assertEnum(label, 'ProjectedOrTrue', params.ProjectedOrTrue, ['PROJECTED_LENGTH', 'TRUE_LENGTH']);
  assertBoolean(label, 'DestabilizingLoad', params.DestabilizingLoad);
  const registry = schemaRegistry(anchor.schema, label);
  const loadType = editor.getEntityType(params.AppliedLoad) ?? '';
  if (!conformsTo(registry, loadType, 'IfcStructuralLoad')) throw new Error(`${label}: AppliedLoad must reference an IfcStructuralLoad`);
  const distribution = params.PredefinedType ?? 'NOTDEFINED';
  const configured = loadType === 'IfcStructuralLoadConfiguration';
  if (!configured && ['IfcStructuralLoadSingleForce', 'IfcStructuralLoadSingleDisplacement'].some(t => conformsTo(registry, loadType, t))) throw new Error(`${label}: point loads require a DISCRETE configuration`);
  if (['CONST', 'SINUS', 'PARABOLA'].includes(distribution) && configured) throw new Error(`${label}: ${distribution} must not use a load configuration`);
  if (['LINEAR', 'POLYGONAL', 'DISCRETE'].includes(distribution)) {
    if (!configured) throw new Error(`${label}: ${distribution} requires IfcStructuralLoadConfiguration`);
    const attrs = structuralReferenceAttributes(editor, params.AppliedLoad, store);
    const values = attrs[1], locations = attrs[2];
    const minimum = distribution === 'POLYGONAL' ? 3 : 2;
    if (!Array.isArray(values) || values.length < minimum || distribution === 'LINEAR' && values.length !== 2) throw new Error(`${label}: invalid sample count for ${distribution}`);
    if (!Array.isArray(locations) || locations.length !== values.length) throw new Error(`${label}: ${distribution} requires one-dimensional Locations for each value`);
    const positions = locations.map(v => Array.isArray(v) && v.length === 1 ? v[0] : undefined)
      .map(v => typeof v === 'object' && v !== null && 'real' in v ? v.real : v);
    if (positions.some((v, i) => typeof v !== 'number' || !Number.isFinite(v) || i > 0 && Number(v) <= Number(positions[i - 1]))) throw new Error(`${label}: Locations must be one-dimensional and strictly ascending`);
    const types = values.map(v => editor.getEntityType(asRef(v) ?? 0));
    if (!types[0] || types.some(t => t !== types[0])) throw new Error(`${label}: load samples must have the same entity type`);
    if (distribution !== 'DISCRETE' && ['IfcStructuralLoadSingleForce', 'IfcStructuralLoadSingleDisplacement'].some(t => conformsTo(registry, types[0]!, t))) throw new Error(`${label}: point loads require DISCRETE`);
  }
  if (params.PredefinedType === 'USERDEFINED' && !params.ObjectType) throw new Error(`${label}: USERDEFINED requires ObjectType`);
  if (params.ProjectedOrTrue === 'PROJECTED_LENGTH' && params.GlobalOrLocal === 'LOCAL_COORDS') throw new Error(`${label}: PROJECTED_LENGTH requires GLOBAL_COORDS`);
  return editor.addEntity('IfcStructuralCurveAction', [productGuid(params, anchor.guidRandom), ownerHistoryRef(anchor.ownerHistoryId), params.Name ?? null, params.Description ?? null, params.ObjectType ?? null, null, null, `#${params.AppliedLoad}`, `.${params.GlobalOrLocal ?? 'GLOBAL_COORDS'}.`, params.DestabilizingLoad ?? null, params.ProjectedOrTrue ? `.${params.ProjectedOrTrue}.` : null, `.${params.PredefinedType ?? 'NOTDEFINED'}.`]).expressId;
}
