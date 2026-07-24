/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Point-cloud ray query glue for `RaycastEngine` (issue #1860). Extracted
 * out of `raycast-engine.ts` to keep that file under this repo's
 * ~400-line module-split guideline — this is pure composition logic
 * with no BVH/mesh-raycast state of its own.
 */

import type { Ray, Vec3 } from './raycaster.js';
import type { MagneticSnapResult } from './snap-detector.js';
import { screenToWorldRadius } from './snap-geometry-utils.js';
import type { PickOptions } from './types.js';
import type { PointCloudSpatialIndex } from './pointcloud/point-cloud-spatial-index.js';

/** Source the RaycastEngine queries for point-cloud ray snapping (#1860). */
export interface PointCloudRaySource {
  expressId: number;
  modelIndex?: number;
  index: PointCloudSpatialIndex;
}

/** Supplied by the renderer once point clouds are loaded; empty/null disables point snapping. */
export type PointCloudRayProvider = () => ReadonlyArray<PointCloudRaySource>;

/** Screen-space snap tolerance for point-cloud picking (~8 CSS-equivalent
 *  px at the canvas' device-pixel scale, per the #1860 design brief) —
 *  tighter than the 40-60px mesh vertex/edge snap radii since a scan
 *  point has no larger "target zone" the way an edge or corner does. */
const POINT_CLOUD_SNAP_TOLERANCE_PX = 8;

export interface PointCloudRayResult {
  position: Vec3;
  expressId: number;
  modelIndex?: number;
  distance: number;
}

/**
 * Nearest point, across every loaded point-cloud asset, to `ray` within a
 * small screen-space tolerance of depth `t`, bounded to `[0, maxDistance]`.
 * Returns null when no point cloud is loaded, no point falls within
 * tolerance, or every candidate is filtered out by
 * `hiddenIds`/`isolatedIds` (checked per whole asset — point clouds have
 * no finer-grained visibility, matching the existing GPU pick path in
 * `picking-manager.ts`).
 */
export function queryPointClouds(
  provider: PointCloudRayProvider | null,
  ray: Ray,
  cameraFov: number,
  canvasHeightPx: number,
  maxDistance: number,
  options?: PickOptions,
): PointCloudRayResult | null {
  if (!provider || maxDistance <= 0) return null;
  const sources = provider();
  if (sources.length === 0) return null;

  const toleranceAt = (t: number): number =>
    screenToWorldRadius(POINT_CLOUD_SNAP_TOLERANCE_PX, t, cameraFov, canvasHeightPx);

  let best: PointCloudRayResult | null = null;
  for (const src of sources) {
    if (options?.hiddenIds?.has(src.expressId)) continue;
    if (
      options?.isolatedIds !== null &&
      options?.isolatedIds !== undefined &&
      !options.isolatedIds.has(src.expressId)
    ) {
      continue;
    }
    // Never search past the current best (or the caller's bound) — keeps
    // the "nearest across assets" search itself O(assets).
    const bound = best ? Math.min(maxDistance, best.distance) : maxDistance;
    const hit = src.index.queryRay(ray.origin, ray.direction, bound, toleranceAt);
    if (hit && (!best || hit.distance < best.distance)) {
      best = { position: hit.position, expressId: src.expressId, modelIndex: src.modelIndex, distance: hit.distance };
    }
  }
  return best;
}

/** A released (non-locked) edge-lock result, used whenever a point-cloud
 *  snap wins — point snapping has no edge-lock concept of its own. */
export function releasedEdgeLock(): MagneticSnapResult['edgeLock'] {
  return {
    edge: null,
    meshExpressId: null,
    edgeT: 0,
    shouldLock: false,
    shouldRelease: true,
    isCorner: false,
    cornerValence: 0,
  };
}
