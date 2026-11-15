/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ViewerState } from '@/store';
import { hasPendingInstancedShards } from '@/store/instancedShardQueue';

// List output asks for every object. Cache only ownership evidence for each
// immutable scene/models snapshot; load and pending-shard flags stay live.
const sourceOwners = new WeakMap<ReadonlyMap<number, number>, WeakMap<ViewerState['models'], Map<string, boolean>>>();
function hasModelSource(state: Pick<ViewerState, 'models' | 'resolveGlobalIdInModel'>, modelId: string, counts: ReadonlyMap<number, number>): boolean {
  let models = sourceOwners.get(counts);
  if (!models) { models = new WeakMap(); sourceOwners.set(counts, models); }
  let owners = models.get(state.models);
  if (!owners) { owners = new Map(); models.set(state.models, owners); }
  const known = owners.get(modelId);
  if (known !== undefined) return known;
  for (const id of counts.keys()) {
    if (state.resolveGlobalIdInModel(modelId, id)) { owners.set(modelId, true); return true; }
  }
  owners.set(modelId, false);
  return false;
}

export function modelTrianglesReady(
  state: Pick<ViewerState, 'models' | 'geometryResult' | 'resolveGlobalIdInModel'>,
  modelId: string, counts: ReadonlyMap<number, number> | null,
): boolean {
  const model = state.models.get(modelId);
  const complete = model
    ? !model.geometryRestorePending && (
      model.geometryLoadState !== undefined ? model.geometryLoadState === 'complete'
        : model.loadState !== undefined ? model.loadState === 'complete' : !!model.geometryResult)
    : state.models.size === 0 && !!state.geometryResult;
  if (!complete || !counts || hasPendingInstancedShards(modelId)) return false;
  // A completed store model can outlive its renderer. Another model's replay
  // does not establish a measured zero for this one. Without scoped source
  // evidence stay unavailable, including when the scene has only empty data.
  if (state.models.size === 0) return true;
  return hasModelSource(state, modelId, counts);
}

export function modelTriangleCount(state: ViewerState, modelId: string, counts: ReadonlyMap<number, number> | null): number | null {
  if (!counts || !modelTrianglesReady(state, modelId, counts)) return null;
  let total = 0;
  for (const [id, count] of counts) {
    if (state.models.size === 0 || state.resolveGlobalIdInModel(modelId, id)) total += count;
  }
  return total;
}
