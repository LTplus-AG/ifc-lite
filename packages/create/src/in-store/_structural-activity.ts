/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { SpatialAnchor } from './anchor.js';
import type { StructuralGlobalOrLocal } from './structural-action.js';
import { ownerHistoryRef, productGuid } from './_emit-helpers.js';

export type ActivityAnchor = Pick<SpatialAnchor, 'ownerHistoryId' | 'guidRandom' | 'schema'>;
export interface ActivityParams {
  GlobalId?: string;
  Name?: string;
  Description?: string;
  ObjectType?: string;
  GlobalOrLocal?: StructuralGlobalOrLocal;
}
export interface ActivityResult { activityId: number; loadId: number }

export function assertActivitySchema(anchor: ActivityAnchor, builder: string, modernOnly = false): void {
  if ((anchor.schema && !['IFC2X3', 'IFC4', 'IFC4X3'].includes(anchor.schema)) || (modernOnly && anchor.schema === 'IFC2X3')) {
    throw new Error(`${builder}: unsupported schema ${anchor.schema}`);
  }
}

/** Validate untyped SDK input before authoring any owned entity. */
export function assertEnum(builder: string, field: string, value: unknown, allowed: readonly string[], optional = true): void {
  if (optional && value === undefined) return;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${builder}: ${field} must be one of ${allowed.join(', ')}`);
  }
}
export function assertBoolean(builder: string, field: string, value: unknown, optional = true): void {
  if (optional && value === undefined) return;
  if (typeof value !== 'boolean') throw new Error(`${builder}: ${field} must be true or false`);
}
export function assertAppliedLoad(builder: string, load: unknown): asserts load is object {
  if (load === null || typeof load !== 'object' || Array.isArray(load)) {
    throw new Error(`${builder}: AppliedLoad must be a load object`);
  }
}

/** Validate before writing either the owned load or its activity. Zero is a component. */
export function validateLoad(builder: string, load: unknown, fields: readonly string[]): void {
  assertAppliedLoad(builder, load);
  const values = fields.map(field => Reflect.get(load, field));
  if (!values.some(value => value !== undefined)) throw new Error(`${builder}: supply at least one load component`);
  for (let i = 0; i < values.length; i++) {
    if (values[i] !== undefined && (typeof values[i] !== 'number' || !Number.isFinite(values[i]))) {
      throw new Error(`${builder}: ${fields[i]} must be a finite number`);
    }
  }
}

export function emitActivity(editor: StoreEditor, anchor: ActivityAnchor, params: ActivityParams,
  type: string, loadType: string, load: object, fields: readonly string[], tail: (string | boolean | null)[]): ActivityResult {
  const builder = `add${type.slice(3)}ToStore`;
  assertEnum(builder, 'GlobalOrLocal', params.GlobalOrLocal, ['GLOBAL_COORDS', 'LOCAL_COORDS']);
  const globalId = productGuid(params, anchor.guidRandom);
  const loadId = editor.addEntity(loadType, [Reflect.get(load, 'Name') ?? null,
    ...fields.map(field => {
      const value: number | undefined = Reflect.get(load, field);
      // All supported load components are REAL, including renamed IFC2X3 temperature slots.
      return value === undefined ? null : { real: value };
    })]).expressId;
  const activityId = editor.addEntity(type, [globalId, ownerHistoryRef(anchor.ownerHistoryId),
    params.Name ?? type.slice('IfcStructural'.length).replace(/([a-z])([A-Z])/g, '$1 $2'), params.Description ?? null, params.ObjectType ?? null, null, null,
    `#${loadId}`, `.${params.GlobalOrLocal ?? 'GLOBAL_COORDS'}.`, ...tail]).expressId;
  return { activityId, loadId };
}
