/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schedule backend adapter — drives the `bim.schedule.*` API by calling
 * `extractScheduleOnDemand` against the viewer's active (or requested) model.
 *
 * Results are cached by data-store identity and mutation version so repeated
 * queries avoid reparsing while a pending edit refreshes the schedule.
 */

import { createEffectiveRecordOverlay, type ScheduleBackendMethods, type ScheduleExtractionData } from '@ifc-lite/sdk';
import { extractScheduleOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import type { StoreApi } from './types.js';
import { getModelForRef } from './model-compat.js';
import { getMutationViewForModel } from './mutation-view.js';

const EMPTY_EXTRACTION: ScheduleExtractionData = {
  workSchedules: [],
  tasks: [],
  sequences: [],
  workCalendars: [],
  hasSchedule: false,
};

/**
 * Best-effort resolution of the data store to extract from: explicit modelId,
 * then the legacy single-model store, then the first federated model.
 */
function resolveStore(store: StoreApi, modelId?: string): { data: IfcDataStore; modelId: string } | null {
  const state = store.getState();
  if (modelId) {
    const model = getModelForRef(state, modelId);
    return model?.ifcDataStore ? { data: model.ifcDataStore, modelId } : null;
  }
  if (state.ifcDataStore) {
    const entry = [...state.models].find(([, model]) => model.ifcDataStore === state.ifcDataStore);
    return { data: state.ifcDataStore, modelId: entry?.[0] ?? 'legacy' };
  }
  // Respect the user's active model selection before falling back to the
  // first federated entry — other namespaces (query, selection, viewer)
  // follow the same pattern.
  const activeId = state.activeModelId as string | null | undefined;
  if (activeId) {
    const active = getModelForRef(state, activeId);
    if (active?.ifcDataStore) return { data: active.ifcDataStore, modelId: activeId };
  }
  const firstFederated = state.models?.entries().next().value;
  return firstFederated?.[1].ifcDataStore
    ? { data: firstFederated[1].ifcDataStore, modelId: firstFederated[0] } : null;
}

export function createScheduleAdapter(store: StoreApi): ScheduleBackendMethods {
  /** A mutationVersion change invalidates a same-store extraction. */
  const cache = new WeakMap<IfcDataStore, { version: number; result: ScheduleExtractionData }>();

  const extract = (modelId?: string): ScheduleExtractionData => {
    const resolved = resolveStore(store, modelId);
    if (!resolved) return EMPTY_EXTRACTION;
    const { data: ds, modelId: resolvedModelId } = resolved;
    const version = store.getState().mutationVersion;
    const cached = cache.get(ds);
    if (cached?.version === version) return cached.result;
    try {
      const view = getMutationViewForModel(store, resolvedModelId);
      const result = extractScheduleOnDemand(ds, view
        ? { overlay: createEffectiveRecordOverlay(view, ds) } : undefined) as ScheduleExtractionData;
      cache.set(ds, { version, result });
      return result;
    } catch (err) {
      console.warn('[schedule-adapter] extraction failed', err);
      return EMPTY_EXTRACTION;
    }
  };

  return {
    data: (modelId) => extract(modelId),
    tasks: (modelId) => extract(modelId).tasks,
    workSchedules: (modelId) => extract(modelId).workSchedules,
    sequences: (modelId) => extract(modelId).sequences,
  };
}
