/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one IFC GlobalId → (model, express id) resolution of reviewed changes
 * and reviewed authoring: the parsed GlobalId index of every loaded model,
 * plus the elements this session created (overlay entities carry their
 * GlobalId in attribute 0 and are absent from the parsed index), minus
 * deleted ones. A GlobalId found in several models is ambiguous until the
 * proposal names the model.
 */

import { liveEntityConforms } from '@ifc-lite/create';
import { iterateEffectiveEntityIds } from '@ifc-lite/mutations';
import type { ViewerState } from '@/store';

export interface GlobalIdTarget { globalId: string; modelId?: string }
export type GlobalIdResolution = { modelId: string; expressId: number } | 'missing' | 'ambiguous';

export function resolveGlobalId(state: Pick<ViewerState, 'models' | 'mutationViews'>, target: GlobalIdTarget): GlobalIdResolution {
  const hits: Array<{ modelId: string; expressId: number }> = [];
  for (const [modelId, model] of state.models) {
    if (target.modelId && target.modelId !== modelId) continue;
    const view = state.mutationViews.get(modelId);
    const store = model.ifcDataStore;
    const parsed = store?.entities?.getExpressIdByGlobalId(target.globalId);
    if (store && parsed !== undefined && parsed > 0) {
      if (!view?.isDeleted(parsed) && liveEntityConforms(store, parsed, 'IfcRoot', view)) { hits.push({ modelId, expressId: parsed }); continue; }
      // A source index can mistake non-root attribute zero (e.g. material Name)
      // for GlobalId. Recover the actual root through the canonical inventory.
      for (const { expressId } of iterateEffectiveEntityIds(store, view)) {
        if (store.entities.getGlobalId(expressId) === target.globalId && liveEntityConforms(store, expressId, 'IfcRoot', view)) {
          hits.push({ modelId, expressId }); break;
        }
      }
      if (hits.some(hit => hit.modelId === modelId)) continue;
    }
    const created = view?.getNewEntities().find((entity) => entity.attributes[0] === target.globalId
      && store && liveEntityConforms(store, entity.expressId, 'IfcRoot', view));
    if (created && !view?.isDeleted(created.expressId)) hits.push({ modelId, expressId: created.expressId });
  }
  if (hits.length === 0) return 'missing';
  return hits.length > 1 ? 'ambiguous' : hits[0];
}
