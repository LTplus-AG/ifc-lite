/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Adapter that bridges IfcDataStore (parser output) to the
 * ListDataProvider interface used by @ifc-lite/lists.
 *
 * Handles on-demand property/quantity extraction via WASM when needed.
 * Also handles on-demand attribute extraction for Description, ObjectType,
 * and Tag which are not stored during the fast initial parse.
 */

import type { IfcDataStore, MaterialInfo } from '@ifc-lite/parser';
import {
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  extractEntityAttributesOnDemand,
  extractMaterialsOnDemand,
  extractClassificationsOnDemand,
} from '@ifc-lite/parser';
import type { PropertySet, QuantitySet } from '@ifc-lite/data';
import type { ListDataProvider, ListClassificationRef } from '@ifc-lite/lists';

/** Collect every material-name string an element exposes — top-level
 *  material plus layer / constituent / profile names and list members. */
function materialNamesOf(info: MaterialInfo | null): string[] {
  if (!info) return [];
  const names: string[] = [];
  const push = (s: string | undefined) => { if (s) names.push(s); };
  push(info.name);
  for (const l of info.layers ?? []) { push(l.materialName); push(l.name); }
  for (const c of info.constituents ?? []) { push(c.materialName); push(c.name); }
  for (const p of info.profiles ?? []) { push(p.materialName); push(p.name); }
  for (const m of info.materials ?? []) push(m.name);
  return names;
}

/**
 * Create a ListDataProvider backed by an IfcDataStore.
 * The provider handles on-demand WASM extraction transparently.
 */
export function createListDataProvider(store: IfcDataStore): ListDataProvider {
  // Cache for on-demand attribute extraction (description, objectType, tag)
  // These are not stored during initial parse to keep load times fast,
  // but are needed for list display. Cache avoids re-parsing per column.
  const attrCache = new Map<number, { description: string; objectType: string; tag: string }>();

  // Lazily materialised list of every non-empty express id — used for
  // class-less list targeting. Cached because the provider outlives a run.
  let allIdsCache: number[] | null = null;

  function getOnDemandAttrs(id: number): { description: string; objectType: string; tag: string } {
    const cached = attrCache.get(id);
    if (cached) return cached;

    if (store.source?.length > 0 && store.entityIndex) {
      const attrs = extractEntityAttributesOnDemand(store, id);
      const result = { description: attrs.description, objectType: attrs.objectType, tag: attrs.tag };
      attrCache.set(id, result);
      return result;
    }

    const empty = { description: '', objectType: '', tag: '' };
    attrCache.set(id, empty);
    return empty;
  }

  return {
    getEntitiesByType: (type) => store.entities.getByType(type),

    getEntityName: (id) => store.entities.getName(id),
    getEntityGlobalId: (id) => store.entities.getGlobalId(id),
    getEntityDescription: (id) => store.entities.getDescription(id) || getOnDemandAttrs(id).description,
    getEntityObjectType: (id) => store.entities.getObjectType(id) || getOnDemandAttrs(id).objectType,
    getEntityTag: (id) => getOnDemandAttrs(id).tag,
    getEntityTypeName: (id) => store.entities.getTypeName(id),

    getPropertySets(entityId: number): PropertySet[] {
      if (store.onDemandPropertyMap && store.source?.length > 0) {
        return extractPropertiesOnDemand(store, entityId) as PropertySet[];
      }
      return store.properties?.getForEntity(entityId) ?? [];
    },

    getQuantitySets(entityId: number): QuantitySet[] {
      if (store.onDemandQuantityMap && store.source?.length > 0) {
        return extractQuantitiesOnDemand(store, entityId) as QuantitySet[];
      }
      return store.quantities?.getForEntity(entityId) ?? [];
    },

    getAllEntityIds(): number[] {
      if (allIdsCache) return allIdsCache;
      // Restrict "all elements" to geometry-bearing (selectable) products.
      // The raw expressId column also holds relationships, property sets,
      // materials, classifications and other non-element records — a
      // class-less list should not surface those as rows.
      const ids: number[] = [];
      const col = store.entities.expressId;
      for (let i = 0; i < col.length; i++) {
        const id = col[i];
        if (id && store.entities.hasGeometry(id)) ids.push(id);
      }
      allIdsCache = ids;
      return ids;
    },

    getMaterialNames(entityId: number): string[] {
      return materialNamesOf(extractMaterialsOnDemand(store, entityId));
    },

    getClassifications(entityId: number): ListClassificationRef[] {
      return extractClassificationsOnDemand(store, entityId).map((c) => ({
        system: c.system,
        code: c.identification,
        name: c.name,
      }));
    },

    getStoreyName(entityId: number): string {
      const hierarchy = store.spatialHierarchy;
      if (!hierarchy) return '';
      const storeyId = hierarchy.elementToStorey.get(entityId);
      if (!storeyId) return '';
      return store.entities.getName(storeyId) || '';
    },
  };
}
