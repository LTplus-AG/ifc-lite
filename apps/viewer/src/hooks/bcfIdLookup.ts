/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared BCF ID lookup utilities.
 *
 * Provides conversion between IFC GlobalId strings and expressIds,
 * accounting for multi-model federation offsets and single-model fallback.
 */

import type { FederatedModel } from '@/store/types';
import type { IfcDataStore } from '@ifc-lite/parser';
import { fromGlobalIdFromModels, toGlobalIdFromModels } from '@/store/globalId';

export interface IdLookupResult {
  expressId: number;
  modelId: string;
}

/** Resolve refs to IFC GlobalIds once, preserving first-seen order. Passing a
 * shared `seen` set deduplicates across several serialized BCF groups. */
export function resolveUniqueGlobalIds<T>(
  refs: Iterable<T>,
  resolve: (ref: T) => string | null,
  seen = new Set<string>(),
): string[] {
  const guids: string[] = [];
  for (const ref of refs) {
    const guid = resolve(ref);
    if (guid === null || seen.has(guid)) continue;
    seen.add(guid);
    guids.push(guid);
  }
  return guids;
}

/**
 * Convert IFC GlobalId string to expressId (with model offset for federation).
 * Searches federated models first, then falls back to the legacy single-model store.
 */
export function globalIdToExpressId(
  globalIdString: string,
  models: Map<string, FederatedModel>,
  ifcDataStore: IfcDataStore | null | undefined,
): IdLookupResult | null {
  // Multi-model path
  for (const [modelId, model] of models.entries()) {
    const localExpressId = model.ifcDataStore?.entities?.getExpressIdByGlobalId(globalIdString);
    if (localExpressId !== undefined && localExpressId > 0) {
      return {
        expressId: toGlobalIdFromModels(models, modelId, localExpressId),
        modelId,
      };
    }
  }
  // Single-model fallback
  if (models.size === 0 && ifcDataStore?.entities) {
    const localExpressId = ifcDataStore.entities.getExpressIdByGlobalId(globalIdString);
    if (localExpressId !== undefined && localExpressId > 0) {
      return { expressId: localExpressId, modelId: 'legacy' };
    }
  }
  return null;
}

/**
 * Convert expressId to IFC GlobalId string (reversing federation offset).
 * Searches federated models first, then falls back to the legacy single-model store.
 */
export function expressIdToGlobalId(
  expressId: number,
  models: Map<string, FederatedModel>,
  ifcDataStore: IfcDataStore | null | undefined,
): string | null {
  // Multi-model path: resolve through the centralized reverse conversion helper
  const resolved = fromGlobalIdFromModels(models, expressId);
  if (resolved && resolved.modelId !== 'legacy') {
    const model = models.get(resolved.modelId);
    const globalIdString = model?.ifcDataStore?.entities?.getGlobalId(resolved.expressId);
    if (globalIdString) return globalIdString;
  }
  // Single-model fallback: use legacy ifcDataStore directly
  if (models.size === 0 && ifcDataStore?.entities) {
    const globalIdString = ifcDataStore.entities.getGlobalId(expressId);
    if (globalIdString) return globalIdString;
  }
  return null;
}
