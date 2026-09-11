/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { usePointCloudSync, type UsePointCloudSyncParams } from './usePointCloudSync.js';
import { usePointCloudLifecycle } from './usePointCloudLifecycle.js';
import { useModelPlacementPersistence } from './useModelPlacementPersistence.js';
import { useModelPlacementSync } from './useModelPlacementSync.js';

/** Upload assets, reconcile streamed ownership, then compose placement. The order
 * matters: a replacement upload must not wipe the placement applied beforehand. */
export function useModelAssetsSync(params: UsePointCloudSyncParams & {
  modelIdToIndex?: ReadonlyMap<string, number>;
  geometry: unknown;
}): void {
  useModelPlacementPersistence();
  usePointCloudSync(params);
  usePointCloudLifecycle(params);
  useModelPlacementSync(params.rendererRef, params.isInitialized, params.modelIdToIndex, params.geometry);
}
