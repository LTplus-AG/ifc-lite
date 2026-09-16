/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect } from 'react';
import { useViewerStore, type ViewerState, type FederatedModel } from '@/store';
import { placementFor } from '@/lib/model-placement/state';
import { modelRotationBaker, type RotationTarget } from '@/lib/model-placement/rotation-bake';
import { buildSpatialIndexForModel } from '@/utils/loadingUtils';

/**
 * Make each model's geometry agree with the heading its placement declares.
 *
 * The bake rewrites vertices, so afterwards it takes the SAME two steps a
 * federation re-align takes for the same reason: bump the geometry content
 * version, or the GPU keeps serving the old vertex buffers and the model does
 * not visibly turn; and rebuild the per-model spatial index, a BVH of
 * world-space mesh bounds that otherwise keeps describing the previous heading
 * for `queryByBounds` / `raycast` / `queryFrustum` (#2013).
 */
let reconciling = false;

export function reconcileModelRotations(state: ViewerState): string[] {
  // The bump below re-enters this through the subscription. The second pass
  // would find nothing to do, but re-entering a geometry rewrite is not a thing
  // to leave to luck.
  if (reconciling) return [];
  reconciling = true;
  try {
    return bake(state);
  } finally {
    reconciling = false;
  }
}

function bake(state: ViewerState): string[] {
  const targets = new Map<string, RotationTarget>();
  for (const [modelId, model] of state.models) {
    targets.set(modelId, { geometry: (model as FederatedModel).geometryResult, rotation: placementFor(state.modelPlacement, modelId).rotation });
  }
  const moved = modelRotationBaker.reconcile(targets, state.geometryContentVersion);
  if (moved.length === 0) return moved;
  state.bumpGeometryContentVersion();
  const next = useViewerStore.getState();
  // Tell the baker this bump was its own, so the next pass does not read it as
  // an outside rewrite and bake the angle a second time.
  modelRotationBaker.settle(next.geometryContentVersion);
  for (const modelId of moved) {
    const model = next.models.get(modelId) as FederatedModel | undefined;
    if (model?.ifcDataStore && model.geometryResult) {
      buildSpatialIndexForModel(model.geometryResult.meshes, modelId, model.ifcDataStore);
    }
  }
  return moved;
}

/** Subscribed synchronously, like the placement sync beside it, so a pick
 * cannot observe the committed heading before the geometry carries it. */
export function useModelRotationSync(): void {
  useEffect(() => {
    reconcileModelRotations(useViewerStore.getState());
    return useViewerStore.subscribe((state, previous) => {
      if (state.modelPlacement !== previous.modelPlacement
        || state.models !== previous.models
        || state.geometryContentVersion !== previous.geometryContentVersion) {
        reconcileModelRotations(state);
      }
    });
  }, []);
}
