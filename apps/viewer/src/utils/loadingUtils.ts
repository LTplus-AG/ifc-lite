/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared loading utilities used across all IFC loading hooks.
 *
 * Consolidates the guarded spatial-index build pattern that was
 * duplicated across useIfcLoader, useIfcCache, useIfcServer, and
 * useIfcFederation.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import { buildSpatialIndexAsync } from '@ifc-lite/spatial';
import { useViewerStore } from '../store/index.js';

/**
 * Build a spatial index in the background (time-sliced, non-blocking)
 * with a guard against stale loads.
 *
 * The guard captures the dataStore reference and compares it to the
 * current store when the async build completes. If the store has been
 * replaced (e.g. user loaded a new file), the result is discarded.
 *
 * @param meshes - Final mesh array with correct IDs and world-space positions
 * @param dataStore - The IfcDataStore to attach the spatial index to
 * @param setIfcDataStore - Store setter to trigger re-render
 */
export function buildSpatialIndexGuarded(
  meshes: MeshData[],
  dataStore: IfcDataStore,
  setIfcDataStore: (store: IfcDataStore) => void,
): void {
  if (meshes.length === 0) return;

  const capturedStore = dataStore;
  buildSpatialIndexAsync(meshes).then(spatialIndex => {
    const { ifcDataStore: currentStore } = useViewerStore.getState();
    if (currentStore !== capturedStore) return;
    capturedStore.spatialIndex = spatialIndex;
    setIfcDataStore({ ...capturedStore });
  }).catch(err => {
    console.warn('[loadingUtils] Failed to build spatial index:', err);
  });
}

/**
 * Build a spatial index for a specific (e.g. federated) model.
 *
 * Unlike {@link buildSpatialIndexGuarded}, this never touches the active-model
 * slot: a federated model is usually not the active one, so guarding on / writing
 * through `ifcDataStore` (`setIfcDataStore`) would either discard the index or
 * mutate the wrong model. Instead it guards on the target model still holding the
 * same store and publishes through `updateModel(modelId, ...)`.
 *
 * @param meshes - Final mesh array with correct IDs and world-space positions
 * @param modelId - The federated model to attach the spatial index to
 * @param dataStore - That model's IfcDataStore (mutated in place)
 */
export function buildSpatialIndexForModel(
  meshes: MeshData[],
  modelId: string,
  dataStore: IfcDataStore,
): void {
  if (meshes.length === 0) return;

  buildSpatialIndexAsync(meshes).then(spatialIndex => {
    const state = useViewerStore.getState();
    const model = state.models.get(modelId);
    // Model removed, or its store was replaced since this build started.
    if (!model || model.ifcDataStore !== dataStore) return;
    dataStore.spatialIndex = spatialIndex;
    state.updateModel(modelId, { ifcDataStore: dataStore });
  }).catch(err => {
    console.warn('[loadingUtils] Failed to build spatial index for model:', err);
  });
}
