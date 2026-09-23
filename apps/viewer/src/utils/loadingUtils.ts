/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared loading utilities used across all IFC loading hooks.
 *
 * Builds each model's placed spatial index with stale-load guards.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import { buildSpatialIndexAsync } from '@ifc-lite/spatial';
import { placedMesh } from '@/lib/model-placement/placed-geometry';
import { displayedTranslation } from '@/lib/model-placement/state';
import { placementSnapshot, placementSnapshotIsCurrent } from '@/lib/model-placement/placement-snapshot';
import { useViewerStore } from '../store/index.js';

/**
 * Build a spatial index for a specific (e.g. federated) model.
 *
 * This guards on the target model still holding the same store and publishes
 * through `updateModel(modelId, ...)`, without touching the active-model slot.
 *
 * @param meshes - Final mesh array with correct IDs and world-space positions
 * @param modelId - The federated model to attach the spatial index to
 * @param dataStore - That model's IfcDataStore (mutated in place)
 */
export function buildSpatialIndexForModel(
  meshes: MeshData[],
  modelId: string,
  dataStore: IfcDataStore,
  coordinates: 'source' | 'placed' = 'source',
): void {
  if (meshes.length === 0) return;

  const initial = useViewerStore.getState(), snapshot = placementSnapshot(initial, [modelId], false);
  const generation = nextSpatialIndexGeneration(dataStore);
  const placed = coordinates === 'placed' ? meshes : meshes.map((mesh) => placedMesh(mesh, displayedTranslation(initial.modelPlacement, modelId)));
  buildSpatialIndexAsync(placed).then(spatialIndex => {
    const state = useViewerStore.getState();
    const model = state.models.get(modelId);
    // Model removed, or its store was replaced since this build started.
    if (!model || model.ifcDataStore !== dataStore || generations.get(dataStore) !== generation || !placementSnapshotIsCurrent(snapshot, state)) return;
    dataStore.spatialIndex = spatialIndex;
    state.updateModel(modelId, { ifcDataStore: dataStore });
  }).catch(err => {
    console.warn('[loadingUtils] Failed to build spatial index for model:', err);
  });
}

const generations = new WeakMap<IfcDataStore, number>();
function nextSpatialIndexGeneration(store: IfcDataStore): number {
  const next = (generations.get(store) ?? 0) + 1; generations.set(store, next); return next;
}

/** Withdraw old coordinates immediately and supersede every outstanding build. */
export function invalidateSpatialIndex(store: IfcDataStore): void {
  nextSpatialIndexGeneration(store);
  store.spatialIndex = undefined;
}
