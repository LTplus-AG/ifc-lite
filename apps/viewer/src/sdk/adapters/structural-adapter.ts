/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Structural backend adapter — drives the `bim.structural.*` API by calling
 * `extractStructuralOnDemand` against the viewer's active (or requested)
 * model. Mirrors `schedule-adapter.ts` exactly: same store resolution, same
 * per-model cache, same empty-extraction fallback on a bad model or a thrown
 * extractor.
 *
 * This wires the namespace so `LocalBackend` satisfies `BimBackend` and a
 * sandbox script can call `bim.structural.*` against the viewer's live
 * model; no properties-card or panel UI is added here (layer 4 of #4206,
 * left for a later PR).
 */

import type { StructuralBackendMethods, StructuralExtractionData } from '@ifc-lite/sdk';
import { extractStructuralOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import type { StoreApi } from './types.js';
import { getModelForRef } from './model-compat.js';

const EMPTY_EXTRACTION: StructuralExtractionData = {
  analysisModels: [],
  members: [],
  connections: [],
  activities: [],
  loadGroups: [],
  resultGroups: [],
  hasStructural: false,
  loadsTruncated: false,
};

/** Same resolution order as `schedule-adapter.ts`'s `resolveStore`. */
function resolveStore(store: StoreApi, modelId?: string): IfcDataStore | null {
  const state = store.getState();
  if (modelId) {
    const model = getModelForRef(state, modelId);
    return (model?.ifcDataStore as IfcDataStore | undefined) ?? null;
  }
  if (state.ifcDataStore) return state.ifcDataStore as IfcDataStore;
  const activeId = state.activeModelId as string | null | undefined;
  if (activeId) {
    const active = getModelForRef(state, activeId);
    if (active?.ifcDataStore) return active.ifcDataStore as IfcDataStore;
  }
  const firstFederated = state.models?.values().next().value;
  return (firstFederated?.ifcDataStore as IfcDataStore | undefined) ?? null;
}

export function createStructuralAdapter(store: StoreApi): StructuralBackendMethods {
  /** Cache keyed by IfcDataStore identity (WeakMap avoids leaks on model swap). */
  const cache = new WeakMap<IfcDataStore, StructuralExtractionData>();

  const extract = (modelId?: string): StructuralExtractionData => {
    const ds = resolveStore(store, modelId);
    if (!ds) return EMPTY_EXTRACTION;
    const cached = cache.get(ds);
    if (cached) return cached;
    try {
      const result = extractStructuralOnDemand(ds) as StructuralExtractionData;
      cache.set(ds, result);
      return result;
    } catch (err) {
      console.warn('[structural-adapter] extraction failed', err);
      return EMPTY_EXTRACTION;
    }
  };

  return {
    data: (modelId) => extract(modelId),
    analysisModels: (modelId) => extract(modelId).analysisModels,
    members: (modelId) => extract(modelId).members,
    connections: (modelId) => extract(modelId).connections,
    activities: (modelId) => extract(modelId).activities,
    loadGroups: (modelId) => extract(modelId).loadGroups,
    resultGroups: (modelId) => extract(modelId).resultGroups,
  };
}
