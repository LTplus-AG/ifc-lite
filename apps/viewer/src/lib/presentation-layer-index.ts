/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { resolvePresentationLayers, type PresentationLayer } from './presentation-layers';

const cache = new WeakMap<IfcDataStore, {
  view: MutablePropertyView | null | undefined;
  revision: number | undefined;
  source: IfcDataStore['source'];
  index: ReadonlyMap<number, readonly PresentationLayer[]>;
}>();

/** #9273: selection is O(1); rebuild membership only when the model changes. */
export function presentationLayersByProduct(store: IfcDataStore, view?: MutablePropertyView | null):
ReadonlyMap<number, readonly PresentationLayer[]> {
  const revision = view?.getMutationRevision();
  const current = cache.get(store);
  if (current && current.view === view && current.revision === revision && current.source === store.source) return current.index;
  const index = new Map<number, PresentationLayer[]>();
  for (const layer of resolvePresentationLayers(store, view)) {
    for (const id of layer.productIds) {
      const layers = index.get(id) ?? [];
      layers.push(layer);
      index.set(id, layers);
    }
  }
  cache.set(store, { view, revision, source: store.source, index });
  return index;
}
