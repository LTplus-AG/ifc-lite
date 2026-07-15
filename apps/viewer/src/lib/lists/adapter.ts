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
  extractTypePropertiesOnDemand,
  extractTypeQuantitiesOnDemand,
} from '@ifc-lite/parser';
import type { PropertySet, QuantitySet } from '@ifc-lite/data';
import { RelationshipType } from '@ifc-lite/data';
import { ENTITY_ATTRIBUTES } from '@ifc-lite/lists';
import type { ListDataProvider, ListClassificationRef, DiscoveredColumns } from '@ifc-lite/lists';
import { resolveEntityPredefinedType } from '../entity-predefined-type.js';
import { buildSpatialAncestryIndex, type SpatialAncestryIndex } from '../../utils/spatialHierarchy.js';

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
 *
 * `modelName` is the source model / file display name used by the `model`
 * federation-identity column; pass the `FederatedModel.name` so a list over
 * several models can tell which file each row came from. Defaults to '' for the
 * single-model legacy path where there's nothing to disambiguate.
 */
export function createListDataProvider(store: IfcDataStore, modelName = ''): ListDataProvider {
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

  // Spatial ancestry (element -> containing Site / Building name, + the model's
  // Project name) is precomputed once in a single tree pass, then O(1) per
  // element. Cached because the provider outlives a run and the Site / Building
  // columns hit it per row.
  let ancestryCache: SpatialAncestryIndex | null = null;
  function ancestry(): SpatialAncestryIndex {
    if (!ancestryCache) {
      ancestryCache = buildSpatialAncestryIndex(
        store.spatialHierarchy,
        (id) => store.entities.getName(id),
        (id) => store.entities.getTypeName(id),
      );
    }
    return ancestryCache;
  }

  const usesOnDemandProps = !!store.onDemandPropertyMap && store.source?.length > 0;
  const usesOnDemandQtos = !!store.onDemandQuantityMap && store.source?.length > 0;

  // Geometry-bearing (selectable) products — the raw expressId column also
  // holds relationships, psets, materials, etc., which a class-less list must
  // not surface as rows. Cached; also reused by column discovery to enumerate
  // the model's element types.
  function selectableIds(): number[] {
    if (allIdsCache) return allIdsCache;
    const ids: number[] = [];
    const col = store.entities.expressId;
    for (let i = 0; i < col.length; i++) {
      const id = col[i];
      if (id && store.entities.hasGeometry(id)) ids.push(id);
    }
    allIdsCache = ids;
    return ids;
  }

  function getPropertySetsFor(entityId: number): PropertySet[] {
    if (usesOnDemandProps) return extractPropertiesOnDemand(store, entityId) as PropertySet[];
    return store.properties?.getForEntity(entityId) ?? [];
  }

  function getQuantitySetsFor(entityId: number): QuantitySet[] {
    if (usesOnDemandQtos) return extractQuantitiesOnDemand(store, entityId) as QuantitySet[];
    return store.quantities?.getForEntity(entityId) ?? [];
  }

  // ── Type-inherited property/quantity fallback (issue #1745) ──
  // Resolve the element's IfcTypeProduct once, then cache the extracted type
  // psets/qtos BY TYPE ID so a schedule over thousands of instances sharing a
  // type parses that type only once. `entityToTypeId` memoises the (cheap)
  // relationship lookup; -1 marks "no type" so we don't re-probe.
  const entityToTypeId = new Map<number, number>();
  const typePsetCache = new Map<number, PropertySet[]>();
  const typeQsetCache = new Map<number, QuantitySet[]>();

  function definingTypeId(entityId: number): number {
    const cached = entityToTypeId.get(entityId);
    if (cached !== undefined) return cached;
    const ids = store.relationships?.getRelated(entityId, RelationshipType.DefinesByType, 'inverse') ?? [];
    const typeId = ids.length > 0 ? ids[0] : -1;
    entityToTypeId.set(entityId, typeId);
    return typeId;
  }

  // NOTE: type fallback covers the CLIENT (WASM) parse path — the store that
  // backs the in-browser viewer, which is the #1745 scenario. The server-parse
  // path (convertServerDataModel) does not surface the element→type relationship
  // at all (it drops IfcRelDefinesByType and leaves `definedByType` unset), so
  // `definingTypeId` returns -1 there and these accessors correctly no-op.
  // Wiring server-parsed stores is tracked as a follow-up (needs the Rust
  // relationship + type-pset emission), so we deliberately do NOT add a table
  // fallback here that could never fire.
  function getTypePropertySetsFor(entityId: number): PropertySet[] {
    const typeId = definingTypeId(entityId);
    if (typeId < 0) return [];
    const cached = typePsetCache.get(typeId);
    if (cached) return cached;
    const psets = (extractTypePropertiesOnDemand(store, entityId)?.properties ?? []) as PropertySet[];
    typePsetCache.set(typeId, psets);
    return psets;
  }

  function getTypeQuantitySetsFor(entityId: number): QuantitySet[] {
    const typeId = definingTypeId(entityId);
    if (typeId < 0) return [];
    const cached = typeQsetCache.get(typeId);
    if (cached) return cached;
    const qsets = (extractTypeQuantitiesOnDemand(store, entityId)?.quantities ?? []) as QuantitySet[];
    typeQsetCache.set(typeId, qsets);
    return qsets;
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
    getTypePropertySets: getTypePropertySetsFor,
    getTypeQuantitySets: getTypeQuantitySetsFor,

    getAllEntityIds(): number[] {
      return selectableIds();
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

    getContainerName(entityId: number): string {
      return ancestry().containerOf(entityId);
    },

    getBuildingName(entityId: number): string {
      return ancestry().buildingOf(entityId);
    },

    getSiteName(entityId: number): string {
      return ancestry().siteOf(entityId);
    },

    getProjectName(): string {
      return ancestry().projectName;
    },

    getModelName(): string {
      return modelName;
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

      // Type-level sets (#1745): a pset/qto that lives ONLY on an element's
      // IfcTypeProduct must also be offered by the picker — otherwise the
      // fallback resolves values (e.g. a type-only Manufacturer) the user has
      // no way to select. Enumerate each selectable element's type once
      // (deduped by type id; getType*SetsFor caches the extraction per type).
      const seenTypeIds = new Set<number>();
      for (const id of selectableIds()) {
        const typeId = definingTypeId(id);
        if (typeId < 0 || seenTypeIds.has(typeId)) continue;
        seenTypeIds.add(typeId);
        for (const set of getTypePropertySetsFor(id)) {
          if (!set.name) continue;
          let bucket = properties.get(set.name);
          if (!bucket) { bucket = new Set(); properties.set(set.name, bucket); }
          for (const p of set.properties) if (p.name) bucket.add(p.name);
        }
        for (const set of getTypeQuantitySetsFor(id)) {
          if (!set.name) continue;
          let bucket = quantities.get(set.name);
          if (!bucket) { bucket = new Set(); quantities.set(set.name, bucket); }
          for (const q of set.quantities) if (q.name) bucket.add(q.name);
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
