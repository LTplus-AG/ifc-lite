/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore, type ViewerState, type FederatedModel } from '@/store';
import { placementFor } from '@/lib/model-placement/state';
import { modelRotationBaker, type RotationTarget } from '@/lib/model-placement/rotation-bake';
import { buildPlacedSpatialIndex } from '@/lib/model-placement/spatial-index';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { toRenderTranslation } from '@/lib/model-placement/translation';
import { invalidateSpatialIndex } from '@/utils/loadingUtils';
import { getGlobalRenderer } from '@/hooks/useBCF';

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
/** Depth of {@link withModelRotationsUnbaked} passes in flight. */
let suspended = 0;

/**
 * Push every model's DECLARED heading to the renderer's GPU-instanced
 * occurrence transforms (`Renderer.setModelRotation`, #4890) — the instanced
 * counterpart to the flat-mesh bake this module already does. The pivot is
 * converted into the SAME render frame the bake's vertices and
 * `applyModelRotation`'s pivot are in (`toRenderTranslation`), not the
 * absolute box frame `EntityWorldAabb` uses, so the two halves of one
 * rotation agree on where the axis sits.
 *
 * A model with no GPU-instanced templates is unaffected: `setModelRotation`
 * only ever rewrites instance transforms the renderer already owns.
 */
export function syncModelRotationsToRenderer(
  renderer: Renderer, state: ViewerState, indices: ReadonlyMap<string, number>,
): void {
  for (const modelId of state.models.keys()) {
    const index = indices.get(modelId);
    if (index === undefined) continue;
    const rotation = placementFor(state.modelPlacement, modelId).rotation;
    const pivot = toRenderTranslation(rotation.pivot);
    renderer.setModelRotation(index, rotation.angle, pivot);
  }
}

export function reconcileModelRotations(state: ViewerState): string[] {
  // The bump below re-enters this through the subscription. The second pass
  // would find nothing to do, but re-entering a geometry rewrite is not a thing
  // to leave to luck.
  if (reconciling || suspended > 0) return [];
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
  const moved = modelRotationBaker.reconcile(targets);
  // Instanced occurrences never pass through `modelRotationBaker` — they have
  // no vertices to bake — so the renderer's own transforms are pushed
  // separately, every pass, BEFORE the content-version bump and index rebuild
  // below: the spatial index this function rebuilds has to describe the SAME
  // heading the renderer is about to draw (#4890).
  const renderer = getGlobalRenderer();
  if (renderer) syncModelRotationsToRenderer(renderer, state, modelIndices(state.models));
  if (moved.length === 0) return moved;
  state.bumpGeometryContentVersion();
  const next = useViewerStore.getState();
  for (const modelId of moved) {
    const model = next.models.get(modelId) as FederatedModel | undefined;
    if (model?.ifcDataStore && model.geometryResult) {
      // Withdraw the old index now: the rebuild is asynchronous, and until it
      // lands a raycast would be answered from the previous heading's boxes.
      invalidateSpatialIndex(model.ifcDataStore);
      buildPlacedSpatialIndex(next, modelId);
    }
  }
  return moved;
}

/**
 * Run an operation that rewrites model vertices in place — a federation
 * re-align — with every model un-rotated for its WHOLE duration, then re-apply
 * the declared headings once on top of what it produced.
 *
 * Un-baking at the start is not enough on its own: the operation's own store
 * writes (`updateModel` per model) fire the subscription, and a reconcile in the
 * middle would re-rotate models the operation has not reached yet — which it
 * would then snapshot as their "pre-alignment" state, baking a heading into the
 * snapshot that the next re-align restores and rotates again.
 */
export async function withModelRotationsUnbaked<T>(run: () => Promise<T>): Promise<T> {
  suspended += 1;
  try {
    const state = useViewerStore.getState();
    modelRotationBaker.unbake((modelId) => (state.models.get(modelId) as FederatedModel | undefined)?.geometryResult);
    return await run();
  } finally {
    suspended -= 1;
    // Once, after the operation has written everything, so the headings land
    // on its final geometry. Also on a throw: the models must not be left
    // un-rotated under a placement that still declares a heading.
    if (suspended === 0) reconcileModelRotations(useViewerStore.getState());
  }
}

/** Keep geometry in step with declared headings on every store change that can
 * move either. Returns the unsubscribe. */
export function subscribeModelRotationSync(): () => void {
  reconcileModelRotations(useViewerStore.getState());
  return useViewerStore.subscribe((state, previous) => {
    // Not on `geometryContentVersion`: a bump alone moves no model and no
    // heading, and every geometry replacement also republishes `models`.
    if (state.modelPlacement !== previous.modelPlacement || state.models !== previous.models) {
      reconcileModelRotations(state);
    }
  });
}

/** Subscribed synchronously, like the placement sync beside it, so a pick
 * cannot observe the committed heading before the geometry carries it. */
export function useModelRotationSync(): void {
  useEffect(() => {
    const unsubscribe = subscribeModelRotationSync();
    return () => { unsubscribe(); };
  }, []);
}
