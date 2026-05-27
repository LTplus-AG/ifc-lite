/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Creates a {@link LensDataProvider} from the viewer's data sources.
 *
 * Bridges the abstract provider interface to IfcDataStore + federation:
 * - Multi-model: iterates all models, translates global IDs
 * - Legacy single-model: uses offset = 0
 */

import type { LensDataProvider, PropertySetInfo, ClassificationInfo } from '@ifc-lite/lens';
import type { IfcDataStore } from '@ifc-lite/parser';
import {
  extractEntityAttributesOnDemand,
  extractPropertiesOnDemand,
  extractTypePropertiesOnDemand,
  extractQuantitiesOnDemand,
  extractClassificationsOnDemand,
  extractMaterialsOnDemand,
} from '@ifc-lite/parser';
import { toGlobalIdFromModels } from '@/store/globalId';
import type { FederatedModel } from '@/store/types';

interface ModelEntry {
  id: string;
  name: string;
  ifcDataStore: IfcDataStore;
  idOffset: number;
  maxExpressId: number;
}

/** Scan entity array to find the actual maximum expressId */
function computeMaxExpressId(dataStore: IfcDataStore): number {
  const entities = dataStore.entities;
  if (!entities || entities.count === 0) return 0;
  let max = 0;
  for (let i = 0; i < entities.count; i++) {
    if (entities.expressId[i] > max) max = entities.expressId[i];
  }
  return max;
}

/**
 * Create a LensDataProvider for the viewer's federated models.
 *
 * @param models - Loaded federated models (may be empty in legacy mode)
 * @param legacyDataStore - Single-model data store (fallback)
 */
export function createLensDataProvider(
  models: Map<string, FederatedModel>,
  legacyDataStore: IfcDataStore | null,
): LensDataProvider {
  // Build a flat array for fast iteration
  const entries: ModelEntry[] = [];
  if (models.size > 0) {
    for (const [, model] of models) {
      if (model.ifcDataStore) {
        entries.push({
          id: model.id,
          name: model.name,
          ifcDataStore: model.ifcDataStore,
          idOffset: model.idOffset ?? 0,
          maxExpressId: model.maxExpressId ?? 0,
        });
      }
    }
  } else if (legacyDataStore) {
    entries.push({
      id: 'legacy',
      name: 'Model',
      ifcDataStore: legacyDataStore,
      idOffset: 0,
      maxExpressId: computeMaxExpressId(legacyDataStore),
    });
  }

  return {
    getEntityCount(): number {
      let count = 0;
      for (const entry of entries) {
        count += entry.ifcDataStore.entities?.count ?? 0;
      }
      return count;
    },

    forEachEntity(callback: (globalId: number, modelId: string) => void): void {
      const models = new Map(entries.map((entry) => [entry.id, { idOffset: entry.idOffset }]));
      for (const entry of entries) {
        const entities = entry.ifcDataStore.entities;
        if (!entities) continue;
        for (let i = 0; i < entities.count; i++) {
          const expressId = entities.expressId[i];
          callback(toGlobalIdFromModels(models, entry.id, expressId), entry.id);
        }
      }
    },

    getEntityType(globalId: number): string | undefined {
      const resolved = resolveGlobalId(globalId, entries);
      if (!resolved) return undefined;
      return resolved.entry.ifcDataStore.entities?.getTypeName?.(resolved.expressId);
    },

    getPropertyValue(
      globalId: number,
      propertySetName: string,
      propertyName: string,
    ): unknown {
      const resolved = resolveGlobalId(globalId, entries);
      if (!resolved) return undefined;
      const store = resolved.entry.ifcDataStore;
      const id = resolved.expressId;

      // On-demand extraction path: pre-built table is empty for client-parsed
      // stores, so iterate the same psets we expose via getPropertySets.
      if (store.onDemandPropertyMap && store.source?.length > 0) {
        const instancePsets = extractPropertiesOnDemand(store, id);
        for (const pset of instancePsets) {
          if (pset.name !== propertySetName) continue;
          for (const prop of pset.properties) {
            if (prop.name === propertyName) return prop.value;
          }
        }
        // Fall through to type-inherited psets (Pset_*Common is typically
        // attached to IfcSpaceType / IfcWallType, not the instance).
        const typeProps = extractTypePropertiesOnDemand(store, id);
        if (typeProps) {
          for (const pset of typeProps.properties) {
            if (pset.name !== propertySetName) continue;
            for (const prop of pset.properties) {
              if (prop.name === propertyName) return prop.value;
            }
          }
        }
        return undefined;
      }

      return store.properties?.getPropertyValue?.(id, propertySetName, propertyName);
    },

    getPropertySets(globalId: number): PropertySetInfo[] {
      const resolved = resolveGlobalId(globalId, entries);
      if (!resolved) return [];
      const store = resolved.entry.ifcDataStore;
      const id = resolved.expressId;

      // Properties are extracted lazily — the pre-built table is empty unless
      // server-parsed. Mirror the quantity path and use the on-demand extractor,
      // which itself falls back to the eager table when no on-demand map exists.
      if (store.onDemandPropertyMap && store.source?.length > 0) {
        const instancePsets = extractPropertiesOnDemand(store, id) as PropertySetInfo[];
        // Merge type-inherited psets (Pset_*Common lives on the type entity
        // for occurrences). Instance psets take precedence on name conflict.
        const typeProps = extractTypePropertiesOnDemand(store, id);
        if (!typeProps || typeProps.properties.length === 0) return instancePsets;

        const seen = new Set(instancePsets.map((p) => p.name));
        const merged = instancePsets.slice();
        for (const pset of typeProps.properties) {
          if (!seen.has(pset.name)) merged.push(pset as PropertySetInfo);
        }
        return merged;
      }

      const psets = store.properties?.getForEntity?.(id);
      if (!psets) return [];
      return psets as PropertySetInfo[];
    },

    getEntityAttribute(globalId: number, attrName: string): string | undefined {
      const resolved = resolveGlobalId(globalId, entries);
      if (!resolved) return undefined;
      const store = resolved.entry.ifcDataStore;
      const id = resolved.expressId;

      // Fast path: columnar attributes stored during initial parse
      switch (attrName) {
        case 'Name':
          return store.entities.getName(id) || undefined;
        case 'Description': {
          const desc = store.entities.getDescription?.(id);
          if (desc) return desc;
          break;
        }
        case 'ObjectType': {
          const ot = store.entities.getObjectType?.(id);
          if (ot) return ot;
          break;
        }
        case 'Tag':
          // Tag is not stored in columnar — always on-demand
          break;
        case 'GlobalId':
          return store.entities.getGlobalId(id) || undefined;
        case 'Type':
          return store.entities.getTypeName?.(id) || undefined;
      }

      // Slow path: on-demand extraction from source buffer
      if (store.source?.length > 0 && store.entityIndex) {
        const attrs = extractEntityAttributesOnDemand(store, id);
        switch (attrName) {
          case 'Name': return attrs.name || undefined;
          case 'Description': return attrs.description || undefined;
          case 'ObjectType': return attrs.objectType || undefined;
          case 'Tag': return attrs.tag || undefined;
        }
      }
      return undefined;
    },

    getQuantityValue(
      globalId: number,
      qsetName: string,
      quantName: string,
    ): number | string | undefined {
      const resolved = resolveGlobalId(globalId, entries);
      if (!resolved) return undefined;
      const store = resolved.entry.ifcDataStore;
      const id = resolved.expressId;

      // On-demand quantity extraction
      if (store.onDemandQuantityMap && store.source?.length > 0) {
        const qsets = extractQuantitiesOnDemand(store, id);
        for (const qset of qsets) {
          if (qset.name === qsetName) {
            for (const q of qset.quantities) {
              if (q.name === quantName) return q.value;
            }
          }
        }
        return undefined;
      }

      // Fallback: pre-built quantity tables
      const qsets = store.quantities?.getForEntity?.(id);
      if (!qsets) return undefined;
      for (const qset of qsets) {
        if (qset.name === qsetName) {
          for (const q of qset.quantities) {
            if (q.name === quantName) return q.value;
          }
        }
      }
      return undefined;
    },

    getClassifications(globalId: number): ClassificationInfo[] {
      const resolved = resolveGlobalId(globalId, entries);
      if (!resolved) return [];
      const store = resolved.entry.ifcDataStore;
      return extractClassificationsOnDemand(store, resolved.expressId);
    },

    getQuantitySets(globalId: number): ReadonlyArray<{
      name: string;
      quantities: ReadonlyArray<{ name: string }>;
    }> {
      const resolved = resolveGlobalId(globalId, entries);
      if (!resolved) return [];
      const store = resolved.entry.ifcDataStore;
      const id = resolved.expressId;

      // On-demand quantity extraction
      if (store.onDemandQuantityMap && store.source?.length > 0) {
        return extractQuantitiesOnDemand(store, id);
      }

      // Fallback: pre-built quantity tables
      const qsets = store.quantities?.getForEntity?.(id);
      if (!qsets) return [];
      return qsets as ReadonlyArray<{ name: string; quantities: ReadonlyArray<{ name: string }> }>;
    },

    getMaterialName(globalId: number): string | undefined {
      const resolved = resolveGlobalId(globalId, entries);
      if (!resolved) return undefined;
      const store = resolved.entry.ifcDataStore;
      const info = extractMaterialsOnDemand(store, resolved.expressId);
      if (!info) return undefined;
      // Return the top-level material name, or first layer/constituent name
      if (info.name) return info.name;
      if (info.layers?.length) return info.layers[0].materialName;
      if (info.constituents?.length) return info.constituents[0].materialName;
      if (info.profiles?.length) return info.profiles[0].materialName;
      if (info.materials?.length) return info.materials[0]?.name;
      return undefined;
    },

    getModelId(globalId: number): string | undefined {
      const resolved = resolveGlobalId(globalId, entries);
      if (!resolved) return undefined;
      return resolved.entry.id;
    },

    getModelName(modelId: string): string | undefined {
      const entry = entries.find(e => e.id === modelId);
      return entry?.name ?? modelId;
    },
  };
}

/**
 * Resolve a global ID to (entry, local expressId).
 * O(m) where m = model count (typically 1–5).
 * Reuses a single result object to avoid per-call allocation during
 * hot-loop lens evaluation (100k+ calls).
 */
const _resolved = { entry: null as unknown as ModelEntry, expressId: 0 };

function resolveGlobalId(
  globalId: number,
  entries: ModelEntry[],
): typeof _resolved | null {
  for (const entry of entries) {
    const localId = globalId - entry.idOffset;
    if (localId >= 0 && localId <= entry.maxExpressId) {
      _resolved.entry = entry;
      _resolved.expressId = localId;
      return _resolved;
    }
  }
  return null;
}
