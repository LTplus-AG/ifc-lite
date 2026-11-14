/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { federationRegistry } from '@ifc-lite/renderer';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { StoreApi } from 'zustand';
import type { ViewerState } from './index.js';
import type { FederatedModel } from './types.js';
import { modelExpressIdFloor } from '@/utils/model-mutation-view';

let deferred = 0;
const refreshers = new Set<() => void>();

/** Hydration publishes ownership and its model record in one store commit. */
export function withDeferredOverlayCapacity<T>(action: () => T): T {
  deferred++;
  try { return action(); }
  finally {
    if (--deferred === 0) for (const refresh of refreshers) refresh();
  }
}

/** Evaluate the source watermark at ingestion/binding, outside permission selectors. */
export function minNextOverlayExpressId(modelId: string, source: IfcDataStore | null): number {
  return modelExpressIdFloor(modelId, source)();
}

/** Capacity uses only the registry's range fields and the allocator's next ID. */
export function overlayCapacity(modelId: string, nextId: number): boolean {
  return !federationRegistry.hasModel(modelId) || federationRegistry.hasOverlayCapacity(modelId, nextId);
}

/** Also used before source updates commit, so subscribers never see stale capacity. */
export function refreshModelOverlayCapacity(model: FederatedModel, view?: MutablePropertyView): FederatedModel {
  const nextId = Math.max(view?.peekNextExpressId() ?? 1, minNextOverlayExpressId(model.id, model.ifcDataStore));
  const hasOverlayCapacity = overlayCapacity(model.id, nextId);
  if (model.hasOverlayCapacity === hasOverlayCapacity) return model;
  return { ...model, hasOverlayCapacity };
}

/** Keep selectors on reactive model data, including lazy and direct overlay clients. */
export function registerOverlayCapacity(store: Pick<StoreApi<ViewerState>, 'getState' | 'setState' | 'subscribe'>): void {
  let refreshing = false;
  const dirty = new Set<string>();
  const bound = new Map<string, { view: MutablePropertyView; source: IfcDataStore | null; floor: () => number }>();
  const refresh = () => {
    if (deferred || refreshing) return;
    refreshing = true;
    try {
      let iteration = 0;
      while (dirty.size && iteration++ < 16) {
        const ids = [...dirty];
        dirty.clear();
        for (const modelId of ids) {
          const state = store.getState();
          const model = state.models.get(modelId);
          const view = state.mutationViews.get(modelId);
          const binding = bound.get(modelId);
          if (binding && (view !== binding.view || !model)) {
            binding.view.configureExpressIdAllocator(() => 1);
            bound.delete(modelId);
          }
          if (!model) continue;
          if (view && (view !== binding?.view || model.ifcDataStore !== binding.source)) {
            bound.set(modelId, { view, source: model.ifcDataStore, floor: modelExpressIdFloor(modelId, model.ifcDataStore) });
          }
          if (view) view.configureExpressIdAllocator(bound.get(modelId)!.floor, () => mark(modelId));
          const updated = refreshModelOverlayCapacity(model, view);
          if (updated !== model) {
            const models = new Map(store.getState().models);
            models.set(modelId, updated);
            store.setState({ models });
          }
        }
      }
      if (dirty.size) console.error('[Overlay capacity] Refresh did not stabilize after 16 iterations', [...dirty]);
    } finally { refreshing = false; }
  };
  const mark = (modelId?: string) => {
    if (modelId !== undefined) dirty.add(modelId);
    else {
      for (const id of store.getState().models.keys()) dirty.add(id);
      for (const id of bound.keys()) dirty.add(id);
    }
    refresh();
  };
  refreshers.add(refresh);
  federationRegistry.subscribe(mark);
  store.subscribe((state, previous) => {
    if (state.models === previous.models && state.mutationViews === previous.mutationViews) return;
    for (const [id, model] of state.models) {
      if (model !== previous.models.get(id) || state.mutationViews.get(id) !== previous.mutationViews.get(id)) dirty.add(id);
    }
    for (const id of bound.keys()) if (!state.models.has(id)) dirty.add(id);
    refresh();
  });
  mark();
}
