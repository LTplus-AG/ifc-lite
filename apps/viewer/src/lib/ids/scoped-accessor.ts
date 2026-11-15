/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { IFCDataAccessor } from '@ifc-lite/ids';

/** Restrict candidate enumeration, preserving reference resolution outside
 * the target population (type properties, materials and spatial ancestors).
 * Undefined means whole model; an explicit empty subset stays empty (#10371). */
export function scopedIdsAccessor(accessor: IFCDataAccessor, entityIds?: readonly number[]): IFCDataAccessor {
  if (entityIds === undefined) return accessor;
  const allowed = new Set(entityIds);
  return {
    ...accessor,
    getAllEntityIds: () => accessor.getAllEntityIds().filter(id => allowed.has(id)),
    getEntitiesByType: type => accessor.getEntitiesByType(type).filter(id => allowed.has(id)),
  };
}
