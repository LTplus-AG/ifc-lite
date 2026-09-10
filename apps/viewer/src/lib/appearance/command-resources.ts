/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { IfcDataStore } from '@ifc-lite/parser';
import type { IfcAttributeValue, MutablePropertyView, NewEntity } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { modelAppearanceAssets } from './model-assets.js';

/** One resource lifecycle contract for single-model and coordinated commands. */
export function trackAppearanceCommandResources(modelId: string, commandId: string, dataStore: IfcDataStore,
  view: MutablePropertyView, created: readonly NewEntity[], references: readonly IfcAttributeValue[]) {
  modelAppearanceAssets.authoredLifecycle.track(modelId, commandId, {
    dataStore, view,
    isCurrent: () => useViewerStore.getState().mutationViews.get(modelId) === view
      && useViewerStore.getState().models.get(modelId)?.ifcDataStore === dataStore,
    changed: () => useViewerStore.getState().bumpMutationVersion(),
    subscribe: changed => useViewerStore.subscribe((current, previous) => {
      if (current.mutationVersion !== previous.mutationVersion || current.mutationViews !== previous.mutationViews
        || current.models.has(modelId) !== previous.models.has(modelId)) changed();
    }),
  }, created, references);
}
