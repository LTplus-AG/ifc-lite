/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Keep every registered `MutablePropertyView` reading its model's CURRENT
 * data store (#5672).
 *
 * A view's base readers close over the store they were configured with. A
 * model's store is not fixed for its lifetime: the loader publishes the
 * spatial-ready PARTIAL store first (`onSpatialReady`, whose property table
 * is empty and which has no `onDemandPropertyMap` yet) and swaps in the full
 * store once property parsing finishes. A view created in between (select an
 * element while a large file is still parsing, or any caller of the
 * get-or-create helpers) kept reading the partial store for the rest of the
 * session, so it saw NO base property sets on any entity. The first edit then
 * made the overlay's picture the whole picture:
 *
 *   - adding a property set made every other set vanish from the panel;
 *   - adding a property to an existing set regenerated that set, in the panel
 *     and in the exported IFC, holding only the new property.
 *
 * A store subscription, so it covers every writer of a model's store
 * (`setIfcDataStore`, `updateModel`, `upsertModel`, direct `setState`) and
 * every view creator (the properties panel, the SDK adapter, the zone and
 * drawing-markup helpers, …) without each having to remember. Only views
 * configured through `configureMutationView` are rebound, and only onto a
 * store with source bytes (the partial -> full swap): that is how the
 * viewer builds every view it registers, and a view built some other way has
 * readers this module knows nothing about.
 */

import { configureMutationView, mutationViewBaseStore } from '@/utils/configureMutationView';
import { getModelForRef } from '@/sdk/adapters/model-compat';
import type { ViewerState } from './index.js';

type BindingState = Pick<ViewerState, 'models' | 'ifcDataStore' | 'mutationViews'>;

interface BindingStore {
  subscribe: (listener: (state: BindingState, prev: BindingState) => void) => () => void;
}

/** Point each registered view at its model's current store, where that has changed. */
function rebindMutationViewsToCurrentStores(state: BindingState): void {
  for (const [modelId, view] of state.mutationViews) {
    const bound = mutationViewBaseStore(view);
    if (!bound) continue;
    const current = getModelForRef(state, modelId)?.ifcDataStore;
    // Only a store with source bytes replaces every base reader (see
    // `configureMutationView`); rebinding to a table-backed one would leave the
    // view half on the old store while recording it as moved.
    if (current && current !== bound && current.source?.length > 0) configureMutationView(view, current);
  }
}

export function registerMutationViewStoreBinding(store: BindingStore): void {
  store.subscribe((state, prev) => {
    if (state.models === prev.models
      && state.ifcDataStore === prev.ifcDataStore
      && state.mutationViews === prev.mutationViews) return;
    rebindMutationViewsToCurrentStores(state);
  });
}
