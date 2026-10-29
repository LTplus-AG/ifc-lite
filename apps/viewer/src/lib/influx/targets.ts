/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { iterateEffectiveEntityIds } from '@ifc-lite/mutations';
import type { useViewerStore } from '@/store';
import { effectiveTreeEntityName } from '@/components/viewer/hierarchy/effectiveTypeEntities';
import { resolveEntityRefGlobalIdFromState } from '@/store/resolveEntityRef';

export function influxTargets(state: ReturnType<typeof useViewerStore.getState>) {
  const stores = state.models.size ? [...state.models].map(([modelId, model]) => ({ modelId, store: model.ifcDataStore }))
    : [{ modelId: 'legacy', store: state.ifcDataStore }];
  const targets: Array<{ modelId: string; expressId: number; GlobalId: string; Name: string }> = [];
  for (const { modelId, store } of stores) {
    if (!store) continue;
    // Effective enumeration: skips deleted spaces/sensors and includes ones created in the mutation overlay (#5236).
    const view = state.mutationViews.get(modelId);
    for (const { expressId } of iterateEffectiveEntityIds(store, view, ['IFCSPACE', 'IFCSENSOR'])) {
      const ref = { modelId, expressId };
      const GlobalId = resolveEntityRefGlobalIdFromState(state, ref);
      if (GlobalId) targets.push({ ...ref, GlobalId, Name: effectiveTreeEntityName(store, view, expressId, GlobalId) });
    }
  }
  return targets;
}
