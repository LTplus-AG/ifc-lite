/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { FederatedModel } from '@/store/types';
import { LEGACY_MODEL_ID, LEGACY_MUTATION_MODEL_ID } from '@/sdk/adapters/model-compat';

export interface StoreWithView {
  store: IfcDataStore;
  view: MutablePropertyView | undefined;
}

/** Pair each list source with its own live overlay, including legacy mode. */
export function storesWithMutationViews(
  stores: readonly IfcDataStore[],
  models: ReadonlyMap<string, FederatedModel>,
  mutationViews: ReadonlyMap<string, MutablePropertyView>,
  modelIds?: readonly string[],
): StoreWithView[] {
  const viewsByStore = new Map(Array.from(models.values(), (model) => [
    model.ifcDataStore, mutationViews.get(model.id),
  ] as const));
  return stores.map((store, index) => {
    const modelId = modelIds?.[index];
    const view = models.size > 0
      ? modelId ? mutationViews.get(modelId) : viewsByStore.get(store)
      : mutationViews.get(LEGACY_MUTATION_MODEL_ID) ?? mutationViews.get(LEGACY_MODEL_ID);
    return { store, view };
  });
}
