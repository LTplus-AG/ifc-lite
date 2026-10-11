/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The native structural SDK, Properties and selected evidence share one current reader (#7195). */

import type { StructuralBackendMethods, StructuralExtractionData } from '@ifc-lite/sdk';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { StoreApi } from './types.js';
import { getModelForRef } from './model-compat.js';
import { getMutationViewForModel } from './mutation-view.js';
import { effectiveStructuralData } from '@/components/viewer/properties/effectiveStructuralData';

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
function resolveStore(store: StoreApi, modelId?: string): { store: IfcDataStore; modelId: string } | null {
  const state = store.getState();
  if (modelId) {
    const model = getModelForRef(state, modelId);
    return model?.ifcDataStore ? { store: model.ifcDataStore, modelId } : null;
  }
  if (state.ifcDataStore) return { store: state.ifcDataStore, modelId: '__legacy__' };
  const activeId = state.activeModelId;
  const active = activeId ? getModelForRef(state, activeId) : null;
  if (active?.ifcDataStore && activeId) return { store: active.ifcDataStore, modelId: activeId };
  const first = state.models.values().next().value;
  return first?.ifcDataStore ? { store: first.ifcDataStore, modelId: first.id } : null;
}

export function createStructuralAdapter(store: StoreApi): StructuralBackendMethods {
  const extract = (modelId?: string): StructuralExtractionData => {
    const resolved = resolveStore(store, modelId);
    if (!resolved) return EMPTY_EXTRACTION;
    try {
      return effectiveStructuralData(resolved.store, getMutationViewForModel(store, resolved.modelId));
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
