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
import { ENTITY_ATTRIBUTES } from '@ifc-lite/lists';
import type { ListDataProvider, ListClassificationRef, DiscoveredColumns } from '@ifc-lite/lists';
import { resolveEntityPredefinedType } from '../entity-predefined-type.js';

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

  // PredefinedType re-parses the entity (no columnar accessor); cache it so
  // a list column doesn't re-extract per row across re-renders.
  const predefCache = new Map<number, string>();
  function getPredefinedTypeFor(id: number): string {
    const cached = predefCache.get(id);
    if (cached !== undefined) return cached;
    const value = resolveEntityPredefinedType(store, id) ?? '';
    predefCache.set(id, value);
    return value;
  }

  // Complete column discovery is cached — the provider outlives a builder
  // open, and the scan touches every entity that declares a pset/qto.
  let columnsCache: DiscoveredColumns | null = null;

  const usesOnDemandProps = !!store.onDemandPropertyMap && store.source?.length > 0;
  const usesOnDemandQtos = !!store.onDemandQuantityMap && store.source?.length > 0;

  function getPropertySetsFor(entityId: number): PropertySet[] {
    if (usesOnDemandProps) return extractPropertiesOnDemand(store, entityId) as PropertySet[];
    return store.properties?.getForEntity(entityId) ?? [];
  }

  function getQuantitySetsFor(entityId: number): QuantitySet[] {
    if (usesOnDemandQtos) return extractQuantitiesOnDemand(store, entityId) as QuantitySet[];
    return store.quantities?.getForEntity(entityId) ?? [];
  }

  return {
    getEntitiesByType: (type) => store.entities.getByType(type),

    getEntityName: (id) => store.entities.getName(id),
    getEntityGlobalId: (id) => store.entities.getGlobalId(id),
    getEntityDescription: (id) => store.entities.getDescription(id) || getOnDemandAttrs(id).description,
    getEntityObjectType: (id) => store.entities.getObjectType(id) || getOnDemandAttrs(id).objectType,
    getEntityPredefinedType: (id) => getPredefinedTypeFor(id),
    getEntityTag: (id) => getOnDemandAttrs(id).tag,
    getEntityTypeName: (id) => store.entities.getTypeName(id),

    getPropertySets: getPropertySetsFor,
    getQuantitySets: getQuantitySetsFor,

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

    discoverAllColumns(): DiscoveredColumns {
      if (columnsCache) return columnsCache;

      const properties = new Map<string, Set<string>>();
      const quantities = new Map<string, Set<string>>();

      const ingestProps = (id: number) => {
        for (const set of getPropertySetsFor(id)) {
          if (!set.name) continue;
          let bucket = properties.get(set.name);
          if (!bucket) { bucket = new Set(); properties.set(set.name, bucket); }
          for (const p of set.properties) if (p.name) bucket.add(p.name);
        }
      };
      const ingestQtos = (id: number) => {
        for (const set of getQuantitySetsFor(id)) {
          if (!set.name) continue;
          let bucket = quantities.get(set.name);
          if (!bucket) { bucket = new Set(); quantities.set(set.name, bucket); }
          for (const q of set.quantities) if (q.name) bucket.add(q.name);
        }
      };

      // On-demand path: scan exactly the entities that declare a pset/qto —
      // the minimal complete set (every distinct set/property in the model).
      if (usesOnDemandProps && store.onDemandPropertyMap) {
        for (const id of store.onDemandPropertyMap.keys()) ingestProps(id);
      }
      if (usesOnDemandQtos && store.onDemandQuantityMap) {
        for (const id of store.onDemandQuantityMap.keys()) ingestQtos(id);
      }
      // Table path (e.g. server-loaded models): scan the entity column using
      // the pre-built tables. Capped so it can't run away on huge models.
      if (!usesOnDemandProps || !usesOnDemandQtos) {
        const col = store.entities.expressId;
        const CAP = 100_000;
        for (let i = 0, seen = 0; i < col.length && seen < CAP; i++) {
          const id = col[i];
          if (!id) continue;
          seen++;
          if (!usesOnDemandProps) ingestProps(id);
          if (!usesOnDemandQtos) ingestQtos(id);
        }
      }

      const toSorted = (m: Map<string, Set<string>>) => {
        const out = new Map<string, string[]>();
        for (const [k, s] of m) out.set(k, Array.from(s).sort());
        return out;
      };
      columnsCache = {
        attributes: [...ENTITY_ATTRIBUTES],
        properties: toSorted(properties),
        quantities: toSorted(quantities),
      };
      return columnsCache;
    },
  };
}
