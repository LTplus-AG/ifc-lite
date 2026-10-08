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

import type { ViewerState } from '@/store';

export interface GlobalIdTarget { globalId: string; modelId?: string }
export type GlobalIdResolution = { modelId: string; expressId: number } | 'missing' | 'ambiguous';

export function resolveGlobalId(state: Pick<ViewerState, 'models' | 'mutationViews'>, target: GlobalIdTarget): GlobalIdResolution {
  const hits: Array<{ modelId: string; expressId: number }> = [];
  for (const [modelId, model] of state.models) {
    if (target.modelId && target.modelId !== modelId) continue;
    const view = state.mutationViews.get(modelId);
    const parsed = model.ifcDataStore?.entities?.getExpressIdByGlobalId(target.globalId);
    if (parsed !== undefined && parsed > 0 && !view?.isDeleted(parsed)) { hits.push({ modelId, expressId: parsed }); continue; }
    const created = view?.getNewEntities().find((entity) => entity.attributes[0] === target.globalId);
    if (created && !view?.isDeleted(created.expressId)) hits.push({ modelId, expressId: created.expressId });
  }
  if (hits.length === 0) return 'missing';
  return hits.length > 1 ? 'ambiguous' : hits[0];
}
