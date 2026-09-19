/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ViewerState } from '@/store';
import { resolveEntityRefGlobalIdFromState } from '@/store/resolveEntityRef';

type CaptureState = Pick<ViewerState,
  | 'models' | 'ifcDataStore' | 'mutationViews'
  | 'hiddenEntities' | 'isolatedEntities'
  | 'hiddenEntitiesByModel' | 'isolatedEntitiesByModel'>;

/** Source models represented by the exact visibility snapshot serialized to BCF. */
export function visibilityModelIdsForCapture(
  state: CaptureState,
  resolveGlobalId: (globalId: number) => string | readonly string[] | null,
): string[] {
  const modelIds = new Set<string>();
  const scoped = state.isolatedEntities !== null
    ? state.isolatedEntitiesByModel
    : state.hiddenEntitiesByModel;
  for (const [modelId, ids] of scoped) {
    if (ids.size > 0) modelIds.add(modelId);
  }

  const ids = state.isolatedEntities ?? state.hiddenEntities;
  for (const globalId of ids) {
    const resolved = resolveGlobalId(globalId);
    const guids = typeof resolved === 'string' ? [resolved] : resolved ?? [];
    if (guids.length === 0) continue;
    if (state.models.size === 0) modelIds.add('legacy');
    // Revision federations can legitimately share a GlobalId. Preserve every
    // matching source rather than attributing the component to the first map entry.
    for (const [modelId, model] of state.models) {
      const exactGuid = resolveEntityRefGlobalIdFromState(state, {
        modelId, expressId: globalId - model.idOffset,
      });
      if (exactGuid && guids.includes(exactGuid)) modelIds.add(modelId);
    }
  }
  return [...modelIds];
}
