/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store';

/** A separate mask, so switching modes never overwrites manual hides/isolation.
 * Includes instanced products as well as flat meshes.
 */
export function structuralViewHidden(
  mode: 'both' | 'physical' | 'analytical',
  models: ReadonlyMap<string, FederatedModel>,
  fallback: IfcDataStore | null,
  views: ReadonlyMap<string, MutablePropertyView>,
  hidden: Set<number>,
  toGlobalId: (modelId: string, expressId: number) => number,
): Set<number> {
  if (mode === 'both') return hidden;
  const result = new Set(hidden);
  const mask = (id: number, type: string, global: (id: number) => number) => {
    const analytical = /^IfcStructural(?:Curve|Surface|Point)(?:Member|Connection)/.test(type)
      || /^IfcStructural.*(?:Action|Reaction)$/.test(type);
    if ((mode === 'physical' && analytical) || (mode === 'analytical' && !analytical)) result.add(global(id));
  };
  const visit = (store: IfcDataStore, global: (id: number) => number) => {
    for (const id of store.entities.expressId) {
      const type = store.entities.getExactTypeName?.(id) ?? store.entities.getTypeName(id);
      mask(id, type, global);
    }
  };
  if (models.size) {
    for (const [id, model] of models) {
      if (model.ifcDataStore) visit(model.ifcDataStore, (entity) => toGlobalId(id, entity));
    }
  } else if (fallback) visit(fallback, (id) => id);
  for (const [modelId, view] of views) {
    for (const e of view.getNewEntities()) mask(e.expressId, e.type, (id) => toGlobalId(modelId, id));
  }
  return result;
}
