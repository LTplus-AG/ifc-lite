/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import type { BatchedMesh } from './types.js';
import { BATCH_CONSTANTS } from './constants.js';
import { originPreservesTriangleTopology, topologySafeBatchOrigin } from './scene-precision.js';

export interface PrecisionBucket {
  key: string;
  meshData: MeshData[];
  batchedMesh: BatchedMesh | null;
  vertexBytes: number;
  frameOrigin?: [number, number, number];
}

interface RoutingState {
  buckets: Map<string, PrecisionBucket>;
  activeKeys: Map<string, string>;
  coldKeys: ReadonlySet<string>;
  maxBufferSize: number;
  sharedOrigin: [number, number, number] | undefined;
  nextSplitKey(): string;
}

/** Route by GPU size and by the fixed f32-safe frame chosen for each bucket. */
export function resolvePrecisionBucket(
  state: RoutingState,
  baseKey: string,
  mesh: MeshData,
): string {
  let key = state.activeKeys.get(baseKey) ?? baseKey;
  const current = state.buckets.get(key);
  const meshBytes = (mesh.positions.length / 3) * BATCH_CONSTANTS.BYTES_PER_VERTEX;
  const currentOrigin = current?.frameOrigin ?? current?.batchedMesh?.origin;
  const precisionOverflow = (current?.vertexBytes ?? 0) > 0 && currentOrigin !== undefined
    && !originPreservesTriangleTopology([mesh], currentOrigin);
  const sizeOverflow = (current?.vertexBytes ?? 0) > 0
    && (current?.vertexBytes ?? 0) + meshBytes > state.maxBufferSize;

  // Cold buckets are sealed: their empty CPU shell represents disk-backed
  // content and must never absorb a new arrival.
  if ((current && state.coldKeys.has(key)) || sizeOverflow || precisionOverflow) {
    key = state.nextSplitKey();
    state.activeKeys.set(baseKey, key);
  }

  let target = state.buckets.get(key);
  if (!target) {
    target = {
      key,
      meshData: [],
      batchedMesh: null,
      vertexBytes: 0,
      frameOrigin: topologySafeBatchOrigin([mesh], undefined, state.sharedOrigin),
    };
    state.buckets.set(key, target);
  }
  target.vertexBytes += meshBytes;
  return key;
}
