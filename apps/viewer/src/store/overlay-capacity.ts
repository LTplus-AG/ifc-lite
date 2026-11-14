/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { federationRegistry } from '@ifc-lite/renderer';
import { highestExistingExpressId, type MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { StoreApi } from 'zustand';
import type { ViewerState } from './index.js';

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

function ownedEnd(modelId: string): number {
  const range = federationRegistry.getGlobalIdRange(modelId);
  const offset = federationRegistry.getOffset(modelId);
  return range && offset !== null ? range.end - offset : 0;
}

/** Evaluate the source watermark at ingestion/binding, outside permission selectors. */
export function minNextOverlayExpressId(modelId: string, store: IfcDataStore | null): number {
  const watermark = store?.entityIndex?.byId ? highestExistingExpressId(store) : 0;
  return Math.max(watermark, ownedEnd(modelId)) + 1;
}

/** Capacity uses only the registry's range fields and the allocator's next ID. */
export function overlayCapacity(modelId: string, nextId: number): boolean {
  return !federationRegistry.hasModel(modelId) || federationRegistry.hasOverlayCapacity(modelId, nextId);
}

/** Keep selectors on reactive model data, including lazy and direct overlay clients. */
export function registerOverlayCapacity(store: Pick<StoreApi<ViewerState>, 'getState' | 'setState' | 'subscribe'>): void {
  let refreshing = false;
  const bound = new Map<string, { view: MutablePropertyView; source: IfcDataStore | null; floor: () => number }>();
  const refresh = () => {
    if (deferred || refreshing) return;
    refreshing = true;
    try {
      const state = store.getState();
      for (const [id, binding] of bound) {
        if (state.mutationViews.get(id) !== binding.view) {
          binding.view.configureExpressIdAllocator(() => 1);
          bound.delete(id);
        }
      }
      let models = state.models;
      for (const [modelId, model] of state.models) {
        const view = state.mutationViews.get(modelId);
        const binding = bound.get(modelId);
        if (view && (view !== binding?.view || model.ifcDataStore !== binding.source)) {
          const source = model.ifcDataStore;
          const watermark = source?.entityIndex?.byId ? highestExistingExpressId(source) : 0;
          const floor = () => Math.max(watermark, ownedEnd(modelId)) + 1;
          bound.set(modelId, { view, source, floor });
        }
        if (view) view.configureExpressIdAllocator(bound.get(modelId)!.floor, refresh);
        const nextId = view?.peekNextExpressId() ?? minNextOverlayExpressId(modelId, model.ifcDataStore);
        const hasOverlayCapacity = overlayCapacity(modelId, nextId);
        if (model.hasOverlayCapacity !== hasOverlayCapacity) {
          if (models === state.models) models = new Map(models);
          models.set(modelId, { ...model, hasOverlayCapacity });
        }
      }
      if (models !== state.models) store.setState({ models });
    } finally { refreshing = false; }
  };
  refreshers.add(refresh);
  federationRegistry.subscribe(refresh);
  store.subscribe((state, previous) => {
    if (state.models !== previous.models || state.mutationViews !== previous.mutationViews) refresh();
  });
  refresh();
}
