/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useRef, type MutableRefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore, type ViewerState } from '@/store';
import { endClashScenePresentation } from '@/lib/clash/visibility-ownership';
import { displayedTranslation } from '@/lib/model-placement/state';
import { createPlacementIndexSync } from '@/lib/model-placement/spatial-index';
import { placementMoved, staleMeasurementIds } from '@/lib/model-placement/spatial-invalidation';
import { equalTranslation, toRenderTranslation } from '@/lib/model-placement/translation';
import { createPreviewAnalysis } from '@/lib/model-placement/preview-analysis';
import { publishPlacementBounds } from '@/lib/model-placement/bounds-revision';

/** The same model index map as mesh/instance upload, never a second allocator. */
export function syncModelPlacements(renderer: Renderer, state: ViewerState, indices?: ReadonlyMap<string, number>, previous?: ViewerState): void {
  for (const [id, model] of state.models) {
    const displayed = displayedTranslation(state.modelPlacement, id);
    if (previous && equalTranslation(displayed, displayedTranslation(previous.modelPlacement, id))) continue;
    const translation = toRenderTranslation(displayed);
    renderer.setModelTranslation(indices?.get(id) ?? 0, translation);
    if (model.pointCloudHandleId !== undefined) {
      renderer.setPointCloudTranslation({ id: model.pointCloudHandleId }, translation);
    }
  }
  publishPlacementBounds();
}

/** Mounted after geometry/point-cloud upload effects. Subscribe synchronously so
 * a pointer pick cannot observe the state revision before the renderer moves. */
export function useModelPlacementSync(
  rendererRef: MutableRefObject<Renderer | null>, initialized: boolean,
  indices: ReadonlyMap<string, number> | undefined, geometry: unknown,
): void {
  const previewAnalysis = useRef(createPreviewAnalysis());
  useEffect(() => {
    if (!initialized || !rendererRef.current) return;
    const sync = (state: ViewerState, previous?: ViewerState) => {
      const renderer = rendererRef.current;
      if (renderer) syncModelPlacements(renderer, state, indices, previous);
    };
    sync(useViewerStore.getState());
    const index = createPlacementIndexSync();
    index.refreshMissing(useViewerStore.getState());
    const unsubscribe = useViewerStore.subscribe((state, previous) => {
      if (state.modelPlacement === previous.modelPlacement) return;
      sync(state, previous);
      const restored = previewAnalysis.current(state, previous, rendererRef.current!);
      if (!placementMoved(state, previous)) return;
      index.update(state, previous);
      if (restored) { useViewerStore.setState(restored); state.resetMeasureGesture(); return; }
      useViewerStore.setState({ placementStaleMeasurements: staleMeasurementIds(state) });
      state.resetMeasureGesture();
      if (state.clashResult || state.clashSelectedId !== null || state.clashSolidStatus !== 'none') {
        endClashScenePresentation(useViewerStore.getState, 'model-removed'); // Surviving-model cleanup also cancels in-flight solids.
      }
      if (state.clashResult) { state.setClashResult(null); state.setClashError('Model positions changed. Run clash detection again.'); }
      state.setPointCloudDeviationComputed(false);
      if (state.pointCloudColorMode === 'deviation') state.setPointCloudColorMode('rgb');
    });
    return () => { unsubscribe(); index.dispose(); };
  }, [rendererRef, initialized, indices, geometry]);
}
