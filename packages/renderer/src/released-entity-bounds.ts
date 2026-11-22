/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import type { BoundingBox } from './scene-raycaster.js';
import { worldAabbFromPieces } from './scene-geometry.js';

/**
 * Grow each entity's cached world box by these (placed) meshes. Ephemeral
 * streaming (#10264 released-geometry replay) keeps no CPU pieces to derive
 * boxes from at finish, and one entity's pieces can span several batches, so
 * boxes are unioned as the batches pass instead of computed once.
 */
export function unionEntityWorldBounds(cache: Map<number, BoundingBox>, meshes: readonly MeshData[]): void {
  for (const mesh of meshes) {
    const box = worldAabbFromPieces([mesh]);
    if (!box) continue;
    const prior = cache.get(mesh.expressId);
    cache.set(mesh.expressId, prior ? unionBox(prior, box) : box);
  }
}

export function unionBox(a: BoundingBox, b: BoundingBox): BoundingBox {
  return {
    min: { x: Math.min(a.min.x, b.min.x), y: Math.min(a.min.y, b.min.y), z: Math.min(a.min.z, b.min.z) },
    max: { x: Math.max(a.max.x, b.max.x), y: Math.max(a.max.y, b.max.y), z: Math.max(a.max.z, b.max.z) },
  };
}
