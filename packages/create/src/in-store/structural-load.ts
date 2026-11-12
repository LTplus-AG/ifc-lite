/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { conformsTo, schemaRegistry } from './schema-attributes.js';
import type { StoreEditor } from '@ifc-lite/mutations';
import { assertActivitySchema, type ActivityAnchor } from './_structural-activity.js';

export type StructuralLoadInStoreParams =
  | { Type: 'IfcStructuralLoadConfiguration'; Name?: string; Values: number[]; Locations?: number[][] }
  | { Type: 'IfcSurfaceReinforcementArea'; Name?: string; SurfaceReinforcement1?: number[]; SurfaceReinforcement2?: number[]; ShearReinforcement?: number };

/** Author a reusable load/result resource in native model units. References are borrowed. */
export function addStructuralLoadToStore(editor: StoreEditor, anchor: ActivityAnchor, params: StructuralLoadInStoreParams): number {
  const label = 'addStructuralLoadToStore';
  assertActivitySchema(anchor, label, true);
  const registry = schemaRegistry(anchor.schema, label);
  const realList = (values: number[]) => values.map(real => ({ real }));
  if (params.Type === 'IfcStructuralLoadConfiguration') {
    if (!Array.isArray(params.Values) || !params.Values.length || params.Values.some(id => !conformsTo(registry, editor.getEntityType(id) ?? '', 'IfcStructuralLoadOrResult'))) throw new Error(`${label}: Values must reference load/result resources`);
    if (params.Locations !== undefined && (!Array.isArray(params.Locations) || params.Locations.length !== params.Values.length || params.Locations.some(v => !Array.isArray(v) || v.length < 1 || v.length > 2 || !v.every(Number.isFinite)))) throw new Error(`${label}: Locations must match Values and contain one or two finite coordinates`);
    return editor.addEntity('IfcStructuralLoadConfiguration', [params.Name ?? null, params.Values.map(id => `#${id}`), params.Locations?.map(realList) ?? null]).expressId;
  }
  if (params.Type !== 'IfcSurfaceReinforcementArea') throw new Error(`${label}: unsupported Type`);
  const arrays = [params.SurfaceReinforcement1, params.SurfaceReinforcement2];
  if (arrays.every(v => v === undefined) && params.ShearReinforcement === undefined) throw new Error(`${label}: specify reinforcement area`);
  if (arrays.some(v => v !== undefined && (!Array.isArray(v) || v.length < 2 || v.length > 3 || !v.every(x => Number.isFinite(x) && x >= 0))) || (params.ShearReinforcement !== undefined && (!Number.isFinite(params.ShearReinforcement) || params.ShearReinforcement < 0))) throw new Error(`${label}: reinforcement must be finite and nonnegative; surface lists need two or three values`);
  return editor.addEntity('IfcSurfaceReinforcementArea', [params.Name ?? null, ...arrays.map(v => v ? realList(v) : null), params.ShearReinforcement === undefined ? null : { real: params.ShearReinforcement }]).expressId;
}
