/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { useViewerStore } from '@/store';
import { resolveEntityRefGlobalIdFromState } from '@/store/resolveEntityRef';

export function influxTargets(state: ReturnType<typeof useViewerStore.getState>) {
  const stores = state.models.size ? [...state.models].map(([modelId, model]) => ({ modelId, store: model.ifcDataStore }))
    : [{ modelId: 'legacy', store: state.ifcDataStore }];
  const targets: Array<{ modelId: string; expressId: number; GlobalId: string; Name: string }> = [];
  for (const { modelId, store } of stores) {
    if (!store) continue;
    for (const type of ['IFCSPACE', 'IFCSENSOR']) {
      for (const expressId of store.entityIndex.byType.get(type) ?? []) {
        const ref = { modelId, expressId };
        const GlobalId = resolveEntityRefGlobalIdFromState(state, ref);
        if (GlobalId) targets.push({ ...ref, GlobalId, Name: store.entities.getName(expressId) ?? GlobalId });
      }
    }
  }
  return targets;
}
