/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Spatial index builder - builds BVH from geometry results
 */

import { BVH, type MeshWithBounds } from './bvh.js';
import type { AABB } from './aabb.js';
import type { MeshData } from '@ifc-lite/geometry';

function yieldToEventLoop(): Promise<void> {
  const maybeScheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (typeof maybeScheduler?.yield === 'function') {
    return maybeScheduler.yield();
  }
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
}

/**
 * Build BVH spatial index from geometry meshes
 */
export function buildSpatialIndex(meshes: MeshData[]): BVH {
  const meshesWithBounds: MeshWithBounds[] = meshes.map(mesh => {
    const bounds = computeMeshBounds(mesh);
    return {
      expressId: mesh.expressId,
      bounds,
    };
  });

  return BVH.build(meshesWithBounds);
}

/**
 * Time-sliced version of buildSpatialIndex.
 * Computes mesh bounds in chunks, yielding to the event loop between chunks
 * so orbit/pan stays responsive during index construction.
 *
 * @param meshes  All mesh data
 * @param budgetMs  Max ms per chunk (default 4 — quarter of a 60fps frame)
 * @returns Promise that resolves to the BVH
 */
export async function buildSpatialIndexAsync(
  meshes: MeshData[],
  budgetMs: number = 4,
): Promise<BVH> {
  const meshesWithBounds: MeshWithBounds[] = new Array(meshes.length);

  // Phase 1: compute bounds in time-sliced chunks
  let i = 0;
  while (i < meshes.length) {
    const chunkStart = performance.now();
    while (i < meshes.length) {
      meshesWithBounds[i] = {
        expressId: meshes[i].expressId,
        bounds: computeMeshBounds(meshes[i]),
      };
      i++;
      if (i % 500 === 0 && performance.now() - chunkStart >= budgetMs) {
        await yieldToEventLoop();
        break;
      }
    }
  }

  // Phase 2: BVH build (O(N log N) on pre-computed bounds — fast enough synchronously)
  return BVH.build(meshesWithBounds);
}

/**
 * Compute AABB bounds for a mesh from its positions
 */
function computeMeshBounds(mesh: MeshData): AABB {
  const positions = mesh.positions;
  
  if (positions.length === 0) {
    return {
      min: [0, 0, 0],
      max: [0, 0, 0],
    };
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  // Positions are stored as [x, y, z, x, y, z, ...]
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];

    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }

  // Positions are in the element's local frame (world = origin + position). The
  // spatial index is queried in world space, so lift the AABB by the per-mesh
  // origin. Origin is constant per mesh, so a single add to the final extents is
  // exact and cheapest. No-op when origin is absent/[0,0,0].
  const o = mesh.origin;
  const ox = o ? o[0] : 0;
  const oy = o ? o[1] : 0;
  const oz = o ? o[2] : 0;

  return {
    min: [minX + ox, minY + oy, minZ + oz],
    max: [maxX + ox, maxY + oy, maxZ + oz],
  };
}
