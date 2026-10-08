/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Removable chunks inside one point-cloud asset (#6869).
 *
 * View-dependent LOD streams octree nodes in and out of a single asset, so
 * picking, placement, alignment and visibility stay keyed by one handle
 * while individual nodes come and go. A chunk appended under a key gets its
 * own snap index (`PointCloudSpatialIndex` has no removal: its cells hold
 * positional global ids), and removing the key destroys exactly that key's
 * GPU buffers and index.
 *
 * Asset bounds only grow (as for any streamed asset). An LOD host seeds
 * them with the whole cloud's coarse nodes first, so removal never leaves
 * bounds that are wrong in a way that matters for framing or the height
 * ramp.
 */

import type { PointCloudNode } from './point-cloud-node.js';
import { PointCloudSpatialIndex } from './point-cloud-spatial-index.js';

/** The snap index for `key`, created on first use. */
export function keyedSpatialIndex(node: PointCloudNode, key: string): PointCloudSpatialIndex {
  node.keyedIndexes ??= new Map();
  let index = node.keyedIndexes.get(key);
  if (!index) {
    index = new PointCloudSpatialIndex();
    node.keyedIndexes.set(key, index);
  }
  return index;
}

/** Destroy every GPU chunk and the snap index appended under `key`. Returns the points removed. */
export function removeKeyedChunks(node: PointCloudNode, key: string): number {
  let removed = 0;
  const kept = [];
  for (const chunk of node.chunks) {
    if (chunk.key !== key) {
      kept.push(chunk);
      continue;
    }
    chunk.vertexBuffer.destroy();
    chunk.deviationBuffer.destroy();
    removed += chunk.pointCount;
  }
  node.chunks = kept;
  node.pointCount -= removed;
  const index = node.keyedIndexes?.get(key);
  if (index) {
    index.dispose();
    node.keyedIndexes?.delete(key);
  }
  return removed;
}

export function disposeKeyedIndexes(node: PointCloudNode): void {
  if (!node.keyedIndexes) return;
  for (const index of node.keyedIndexes.values()) index.dispose();
  node.keyedIndexes.clear();
}
