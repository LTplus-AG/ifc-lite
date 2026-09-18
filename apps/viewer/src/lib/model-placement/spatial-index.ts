/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore, type ViewerState } from '@/store';
import { invalidateSpatialIndex, buildSpatialIndexForModel } from '@/utils/loadingUtils';
import { withInstancedMeshes } from '@/utils/instancedExport';
import { displayedTranslation } from './state';
import { equalTranslation } from './translation';

/** Build (or rebuild) `modelId`'s spatial index from its PLACED geometry — flat
 * meshes plus GPU-instanced occurrences materialized at their current heading
 * and translation (`withInstancedMeshes`), so a raycast or bounds query
 * answers at the model's displayed position rather than its source
 * coordinates. Shared by the debounced placement sync below and the rotation
 * bake (`useModelRotationSync.ts`), the two rebuilders of this index (#4890). */
export function buildPlacedSpatialIndex(state: ViewerState, modelId: string): void {
  const model = state.models.get(modelId);
  if (!model?.ifcDataStore || !model.geometryResult) return;
  const geometry = withInstancedMeshes(model.geometryResult, { modelId, idOffset: model.idOffset, maxExpressId: model.maxExpressId });
  buildSpatialIndexForModel(geometry.meshes, modelId, model.ifcDataStore, 'placed');
}

/** Debounce the CPU query index, never geometry uploads. Generation guards in
 * the canonical builder prevent a late load or older move from publishing it. */
export function createPlacementIndexSync() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Set<string>();
  const schedule = () => {
    if (!pending.size) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const latest = useViewerStore.getState();
      for (const id of pending) buildPlacedSpatialIndex(latest, id);
      pending.clear(); timer = undefined;
    }, 200);
  };
  return {
    refreshMissing(state: ViewerState) {
      for (const [id, model] of state.models) {
        if (model.ifcDataStore && !model.ifcDataStore.spatialIndex && model.geometryResult && model.geometryResult.totalTriangles > 0) pending.add(id);
      }
      schedule();
    },
    update(state: ViewerState, previous: ViewerState) {
      for (const [id, model] of state.models) {
        if (!model.ifcDataStore || (state.modelPlacement.frameKey === previous.modelPlacement.frameKey && equalTranslation(
          displayedTranslation(state.modelPlacement, id), displayedTranslation(previous.modelPlacement, id)))) continue;
        invalidateSpatialIndex(model.ifcDataStore);
        pending.add(id);
      }
      schedule();
    },
    dispose() { if (timer) clearTimeout(timer); pending.clear(); },
  };
}
