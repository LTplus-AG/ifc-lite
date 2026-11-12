/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { IfcDataStore } from '@ifc-lite/parser';
import { structuralReferenceAttributes } from './_structural-reference.js';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { ActivityAnchor } from './_structural-activity.js';
export interface StructuralVaryingActionParams {
  VaryingAppliedLoadLocation?: number;
  SubsequentAppliedLoads?: number[];
}
/** IFC2X3 varying actions borrow a ShapeAspect and at least one subsequent load. */
export function varyingActionTail(editor: StoreEditor, anchor: ActivityAnchor, params: StructuralVaryingActionParams, loadType: string, minimum = 1, store?: IfcDataStore) {
  const varying = params.SubsequentAppliedLoads !== undefined || params.VaryingAppliedLoadLocation !== undefined;
  if (!varying) return [];
  if (anchor.schema !== 'IFC2X3') throw new Error('Structural varying action: stations exist only in IFC2X3; use IfcStructuralLoadConfiguration in IFC4+');
  if (!params.VaryingAppliedLoadLocation || editor.getEntityType(params.VaryingAppliedLoadLocation) !== 'IfcShapeAspect' || !Array.isArray(params.SubsequentAppliedLoads) || params.SubsequentAppliedLoads.length < minimum || params.SubsequentAppliedLoads.some(id => editor.getEntityType(id) !== loadType)) throw new Error('Structural varying action: supply VaryingAppliedLoadLocation (IfcShapeAspect) and nonempty SubsequentAppliedLoads of the matching load type');
  const locations = structuralReferenceAttributes(editor, params.VaryingAppliedLoadLocation, store)[0];
  if (!Array.isArray(locations) || locations.length !== 1 + params.SubsequentAppliedLoads.length) throw new Error('Structural varying action: ShapeRepresentations must contain one location per applied load');
  return [`#${params.VaryingAppliedLoadLocation}`, params.SubsequentAppliedLoads.map(id => `#${id}`)];
}
