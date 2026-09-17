/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The store/spatial-index wiring for `rebaseGeometryOntoFirstRealAnchor`
 * (`@ifc-lite/geometry/rtc-rebase`), split out of `useIfcFederation.ts` for
 * module size, same reason `federationRealign.ts` was (#4897).
 *
 * A model with small coordinates gets no `wasmRtcOffset` and is meshed raw.
 * If it loads BEFORE any model that needs a real RTC anchor, `addModel`'s
 * `sharedRtcOffset` (`chooseSharedRtcOffset`) has nothing to give the new
 * model — so call this right after load: when the just-loaded model turns
 * out to be the one that introduces the federation's first real anchor,
 * every earlier, still-raw model is re-based onto it here, keeping the
 * scene — and what `federationFrameInfo` reports — independent of load
 * order.
 */

import { rebaseGeometryOntoFirstRealAnchor, rtcRebaseRefusedForInstancedGeometry } from '@ifc-lite/geometry/rtc-rebase';
import { realRtcAnchorOf } from '@ifc-lite/geometry/world-frame';
import { toast } from '@/components/ui/toast';
import { useViewerStore, type FederatedModel } from '../../store/index.js';
import { buildSpatialIndexForModel } from '../../utils/loadingUtils.js';

/**
 * @param existingModelIdsBeforeLoad The IDs of every OTHER model, as captured
 *   before this load started (the same snapshot `sharedRtcOffset` was chosen
 *   from). IDs, not the model objects: the load in between is an unbounded
 *   await, and a store write during it (`releaseGeometryMemory` on
 *   GPU-upload completion, above all) REPLACES a model's entry with a fresh
 *   `{ ...model, geometryResult }` wrapper. Re-basing the captured wrapper
 *   would mutate an object the store no longer holds — reporting the model
 *   as moved while the live one keeps the anchor-less frame forever, which
 *   is exactly the "reported frame != applied frame" failure of #4897. Every
 *   model object below is therefore read from the store at re-base time.
 * @param hadAnyRealAnchorBeforeLoad Whether any of those already had a real
 *   `wasmRtcOffset` — if so, this is a no-op, because `sharedRtcOffset`
 *   already gave the just-loaded model that same anchor. This one IS a
 *   pre-load fact, and is deliberately still computed before the await.
 * @param justLoadedModelId The model that just finished loading.
 */
export function rebaseFederationOntoNewAnchor(
  existingModelIdsBeforeLoad: readonly string[],
  hadAnyRealAnchorBeforeLoad: boolean,
  justLoadedModelId: string,
): void {
  if (hadAnyRealAnchorBeforeLoad || existingModelIdsBeforeLoad.length === 0) return;

  const models = useViewerStore.getState().models;
  const justLoaded = models.get(justLoadedModelId) as FederatedModel | undefined;
  const newOffset = realRtcAnchorOf(justLoaded);
  // Live entries only: an id whose model was removed during the load is gone.
  const existingEntries = existingModelIdsBeforeLoad
    .map((id) => [id, models.get(id)] as const)
    .filter((entry): entry is readonly [string, FederatedModel] => entry[1] != null);
  const existingGeometries = existingEntries
    .map(([, model]) => model.geometryResult)
    .filter((geometry): geometry is NonNullable<typeof geometry> => geometry != null);

  // GPU-instanced models cannot be re-based at all: their per-occurrence
  // transforms live in renderer-owned instance buffers that the content
  // version bump below deliberately preserves. `rebaseGeometryOntoFirstRealAnchor`
  // refuses the whole federation for that reason; asking the same predicate it
  // uses (rather than re-deriving the condition) is what keeps this message
  // and that decision from drifting apart. All this adds is telling the user,
  // because those models keep the frame they loaded in.
  if (rtcRebaseRefusedForInstancedGeometry(existingGeometries, newOffset)) {
    const message = 'Models loaded before this one use GPU-instanced geometry and keep their original coordinate frame. '
      + 'Load the georeferenced model first to place the whole federation in one frame.';
    console.warn(`[ifc-lite] Federation RTC re-base refused (#4897): ${message}`);
    toast.info(message);
    return;
  }

  const moved = rebaseGeometryOntoFirstRealAnchor(existingGeometries, newOffset);
  if (moved.length === 0) return;

  // Mesh positions and coordinateInfo were mutated in place, same as
  // `realignFederation`'s restore/re-bake: bumpGeometryContentVersion forces
  // the merged-mesh cache and GPU buffers to rebuild.
  useViewerStore.getState().bumpGeometryContentVersion();
  for (const [existingModelId, model] of existingEntries) {
    if (!model.geometryResult || !moved.includes(model.geometryResult)) continue;
    // Re-wrap the model object (even with an empty patch) so store
    // subscribers keyed on `models` see a new Map entry: mutating
    // geometryResult in place alone does not change the Map or model
    // object identity.
    useViewerStore.getState().updateModel(existingModelId, {});
    if (model.ifcDataStore) {
      buildSpatialIndexForModel(model.geometryResult.meshes, existingModelId, model.ifcDataStore);
    }
  }
}
