/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { getGlobalRenderer } from './useBCF.js';
import { hasPendingInstancedShards } from '@/store/instancedShardQueue';

/**
 * The post-stream geometry tail is still running: meshes wait to upload, the
 * streaming fragments have not been finalized, the renderer's time-sliced
 * finalize is in progress, or instanced shards wait to drain. All of it runs on
 * the main thread. The caller decides whether its own stream has completed.
 */
export function isGeometryTailBusy(): boolean {
  const scene = getGlobalRenderer()?.getScene();
  return !!(scene?.hasQueuedMeshes() || scene?.hasStreamingFragments() || scene?.isFinalizeInProgress()) || hasPendingInstancedShards();
}
