/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schedule backend adapter — drives the `bim.schedule.*` API by calling
 * `extractScheduleOnDemand` against the viewer's active (or requested) model.
 *
 * Results are cached per-model until the underlying `ifcDataStore` identity
 * changes, so repeated script / panel queries don't re-parse the STEP source.
 */

import type { ScheduleBackendMethods, ScheduleExtractionData } from '@ifc-lite/sdk';
import { extractScheduleOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import type { StoreApi } from './types.js';
import { getModelForRef } from './model-compat.js';

const EMPTY_EXTRACTION: ScheduleExtractionData = {
  workSchedules: [],
  tasks: [],
  sequences: [],
  hasSchedule: false,
};

/**
 * Best-effort resolution of the data store to extract from: explicit modelId,
 * then the legacy single-model store, then the first federated model.
 */
function resolveStore(store: StoreApi, modelId?: string): IfcDataStore | null {
  const state = store.getState();
  if (modelId) {
    const model = getModelForRef(state, modelId);
    return (model?.ifcDataStore as IfcDataStore | undefined) ?? null;
  }
  if (state.ifcDataStore) return state.ifcDataStore as IfcDataStore;
  // Respect the user's active model selection before falling back to the
  // first federated entry — other namespaces (query, selection, viewer)
  // follow the same pattern.
  const activeId = state.activeModelId as string | null | undefined;
  if (activeId) {
    const active = getModelForRef(state, activeId);
    if (active?.ifcDataStore) return active.ifcDataStore as IfcDataStore;
  }
  const firstFederated = state.models?.values().next().value;
  return (firstFederated?.ifcDataStore as IfcDataStore | undefined) ?? null;
}

export function createScheduleAdapter(store: StoreApi): ScheduleBackendMethods {
  /** Cache keyed by IfcDataStore identity (WeakMap avoids leaks on model swap). */
  const cache = new WeakMap<IfcDataStore, ScheduleExtractionData>();

  const extract = (modelId?: string): ScheduleExtractionData => {
    const ds = resolveStore(store, modelId);
    if (!ds) return EMPTY_EXTRACTION;
    const cached = cache.get(ds);
    if (cached) return cached;
    try {
      const result = extractScheduleOnDemand(ds) as ScheduleExtractionData;
      cache.set(ds, result);
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
