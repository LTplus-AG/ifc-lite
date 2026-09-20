/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared BCF ID lookup utilities.
 *
 * Provides conversion between IFC GlobalId strings and expressIds,
 * accounting for multi-model federation offsets and single-model fallback.
 */

import type { EntityRef, FederatedModel } from '@/store/types';
import type { IfcDataStore } from '@ifc-lite/parser';
import { fromGlobalIdFromModels, toGlobalIdFromModels } from '@/store/globalId';

export interface IdLookupResult {
  expressId: number;
  modelId: string;
}

export type ComponentRef = number | EntityRef;
export type ResolvedGlobalIds = string | readonly string[] | null;

function globalIdsOf(value: ResolvedGlobalIds): readonly string[] {
  if (value === null) return [];
  return typeof value === 'string' ? [value] : value;
}

/** Resolve refs to IFC GlobalIds once, preserving first-seen order. Passing a
 * shared `seen` set deduplicates across several serialized BCF groups. */
export function resolveUniqueGlobalIds<T>(
  refs: Iterable<T>,
  resolve: (ref: T) => ResolvedGlobalIds,
  seen = new Set<string>(),
): string[] {
  const guids: string[] = [];
  for (const ref of refs) {
    for (const guid of globalIdsOf(resolve(ref))) {
      if (seen.has(guid)) continue;
      seen.add(guid);
      guids.push(guid);
    }
  }
  return guids;
}

/** Resolve every model-qualified IFC entity affected by one renderer id.
 * Overlapping model ranges are possible while a collaboration-room model and
 * an ordinary model coexist, so a numeric component is intentionally plural. */
export function resolveCapturedRefGlobalIds(
  ref: ComponentRef,
  modelIds: Iterable<string>,
  resolveInModel: (modelId: string, globalId: number) => EntityRef | null,
  resolveGlobalId: (ref: EntityRef) => string | null,
): string[] {
  const exactRefs: EntityRef[] = [];
  if (typeof ref !== 'number') {
    exactRefs.push(ref);
  } else {
    const ids = [...modelIds];
    if (ids.length === 0) exactRefs.push({ modelId: 'legacy', expressId: ref });
    else {
      for (const modelId of ids) {
        const exact = resolveInModel(modelId, ref);
        if (exact) exactRefs.push(exact);
      }
    }
  }
  return resolveUniqueGlobalIds(exactRefs, resolveGlobalId);
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
