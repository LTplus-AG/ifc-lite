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

import { rebaseGeometryOntoFirstRealAnchor } from '@ifc-lite/geometry/rtc-rebase';
import { realRtcAnchorOf } from '@ifc-lite/geometry/world-frame';
import { useViewerStore, type FederatedModel } from '../../store/index.js';
import { buildSpatialIndexForModel } from '../../utils/loadingUtils.js';

/**
 * @param existingModelsForRtcEntries Every OTHER model, as captured before
 *   this load started (the same snapshot `sharedRtcOffset` was chosen from).
 * @param hadAnyRealAnchorBeforeLoad Whether any of those already had a real
 *   `wasmRtcOffset` — if so, this is a no-op, because `sharedRtcOffset`
 *   already gave the just-loaded model that same anchor.
 * @param justLoadedModelId The model that just finished loading.
 */
export function rebaseFederationOntoNewAnchor(
  existingModelsForRtcEntries: ReadonlyArray<readonly [string, FederatedModel]>,
  hadAnyRealAnchorBeforeLoad: boolean,
  justLoadedModelId: string,
): void {
  if (hadAnyRealAnchorBeforeLoad || existingModelsForRtcEntries.length === 0) return;

  const justLoaded = useViewerStore.getState().models.get(justLoadedModelId) as FederatedModel | undefined;
  const newOffset = realRtcAnchorOf(justLoaded);
  const existingGeometries = existingModelsForRtcEntries
    .map(([, model]) => model.geometryResult)
    .filter((geometry): geometry is NonNullable<typeof geometry> => geometry != null);
  const moved = rebaseGeometryOntoFirstRealAnchor(existingGeometries, newOffset);
  if (moved.length === 0) return;

  // Mesh positions and coordinateInfo were mutated in place, same as
  // `realignFederation`'s restore/re-bake: bumpGeometryContentVersion forces
  // the merged-mesh cache and GPU buffers to rebuild.
  useViewerStore.getState().bumpGeometryContentVersion();
  for (const [existingModelId, model] of existingModelsForRtcEntries) {
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
