/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore, type ViewerState } from '@/store';
import { invalidateSpatialIndex, buildSpatialIndexForModel } from '@/utils/loadingUtils';
import { withInstancedMeshes } from '@/utils/instancedExport';
import { displayedTranslation } from './state';
import { equalTranslation } from './translation';

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
      for (const id of pending) {
        const model = latest.models.get(id);
        if (!model?.ifcDataStore || !model.geometryResult) continue;
        const geometry = withInstancedMeshes(model.geometryResult, { idOffset: model.idOffset, maxExpressId: model.maxExpressId });
        buildSpatialIndexForModel(geometry.meshes, id, model.ifcDataStore, 'placed');
      }
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
