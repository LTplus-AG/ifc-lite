/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ViewerState } from '@/store';
import { hasPendingInstancedShards } from '@/store/instancedShardQueue';

export function modelTrianglesReady(
  state: Pick<ViewerState, 'models' | 'geometryResult'>,
  modelId: string, counts: ReadonlyMap<number, number> | null,
): boolean {
  const model = state.models.get(modelId);
  const complete = model
    ? !model.geometryRestorePending && (
      model.geometryLoadState !== undefined ? model.geometryLoadState === 'complete'
        : model.loadState !== undefined ? model.loadState === 'complete' : !!model.geometryResult)
    : state.models.size === 0 && !!state.geometryResult;
  if (!complete || !counts || hasPendingInstancedShards(modelId)) return false;
  return true;
}

export function modelTriangleCount(state: ViewerState, modelId: string, counts: ReadonlyMap<number, number> | null): number | null {
  if (!counts || !modelTrianglesReady(state, modelId, counts)) return null;
  let total = 0;
  for (const [id, count] of counts) {
    if (state.models.size === 0 || state.resolveGlobalIdInModel(modelId, id)) total += count;
  }
  return total;
}
