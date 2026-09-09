/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ViewerState } from '@/store';
import { placementFor } from './state';
import { placementMoved, staleMeasurementIds } from './spatial-invalidation';
import { equalTranslation } from './translation';

// A deviation computation overwrites GPU buffers even if its result is later
// rejected as stale. Never restore the old heatmap flag after such a write.
const deviationWrites = new WeakMap<object, number>();
export function noteDeviationWrite(renderer: object): void {
  deviationWrites.set(renderer, (deviationWrites.get(renderer) ?? 0) + 1);
}

export function createPreviewAnalysis() {
  let saved: { state: ViewerState; renderer: object; writes: number } | null = null;
  return (state: ViewerState, previous: ViewerState, renderer: object): Partial<ViewerState> | null => {
    if (saved) {
      const base = saved.state;
      const sameContext = saved.renderer === renderer && state.models.size === base.models.size && [...state.models].every(([id, model]) =>
        model.geometryResult === base.models.get(id)?.geometryResult && model.ifcDataStore === base.models.get(id)?.ifcDataStore) &&
        state.mutationVersion === base.mutationVersion && state.georefMutations === base.georefMutations &&
        state.pointCloudAlignmentEnabled === base.pointCloudAlignmentEnabled &&
        state.modelPlacement.frameKey === base.modelPlacement.frameKey;
      const committed = [...state.models.keys()].some((id) => !equalTranslation(
        placementFor(state.modelPlacement, id).translation, placementFor(base.modelPlacement, id).translation));
      if (!sameContext || committed) saved = null;
      else if (!placementMoved(state, base)) {
        const writesUnchanged = saved.writes === (deviationWrites.get(renderer) ?? 0);
        saved = null;
        const originalIds = staleMeasurementIds({ ...base, placementStaleMeasurements: new Set() });
        const stale = new Set([...staleMeasurementIds(state)].filter((id) => !originalIds.has(id) || base.placementStaleMeasurements.has(id)));
        return {
          placementStaleMeasurements: stale,
          // Keep scene presentation cleared: restoring the result list must not
          // resurrect an old async solid request or steal visibility ownership.
          clashResult: base.clashResult, clashRawResult: base.clashRawResult,
          clashGroups: base.clashGroups, clashGroupsKind: base.clashGroupsKind,
          clashExclusionCounts: base.clashExclusionCounts, clashSuppressedCount: base.clashSuppressedCount,
          clashError: base.clashError,
          ...(writesUnchanged ? { pointCloudDeviationComputed: base.pointCloudDeviationComputed,
            pointCloudColorMode: base.pointCloudColorMode } : { pointCloudDeviationComputed: false,
            pointCloudColorMode: state.pointCloudColorMode === 'deviation' ? 'rgb' : state.pointCloudColorMode }),
        };
      }
    }
    if (!saved && state.modelPlacement.preview && placementMoved(state, previous) &&
      !previous.modelPlacement.preview?.delta.some((value) => value !== 0)) {
      saved = { state: previous, renderer, writes: deviationWrites.get(renderer) ?? 0 };
    }
    return null;
  };
}
