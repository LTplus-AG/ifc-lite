/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Inline point clouds take the same georeference alignment as their meshes
 * (#10029). Same staging contract as the mesh loops in `federationAlign.ts`:
 * map each world point, keep the result local to a mapped f64 origin, narrow
 * the residual to f32, and publish nothing until every point succeeded.
 *
 * A committed cloud gets a NEW `chunk` object, so the old one is an exact
 * snapshot for rollback and the pick revision sees the change.
 */

import type { PointCloudAsset } from '@ifc-lite/geometry';
import type { PreAlignmentSnapshot } from '../../store/index.js';

type Triple = [number, number, number];
type PointMap = (x: number, y: number, z: number) => readonly number[] | null | undefined;

export interface StagedCloud {
  cloud: PointCloudAsset;
  origin: Triple;
  chunk: PointCloudAsset['chunk'];
}

/** Map every inline cloud; `null` when any point cannot be mapped or narrowed.
 * `extend` receives each aligned point (world, f64 origin + f32 residual). */
export function stageInlineClouds(
  clouds: readonly PointCloudAsset[] | undefined, map: PointMap, extend: (x: number, y: number, z: number) => void,
): StagedCloud[] | null {
  const staged: StagedCloud[] = [];
  for (const cloud of clouds ?? []) {
    const { positions, pointCount } = cloud.chunk;
    if (pointCount === 0) continue; // a streamed scan's descriptor: aligned by its own registry
    const [ox, oy, oz] = cloud.origin ?? [0, 0, 0];
    // Like the mesh paths: transform the origin when there is one, otherwise
    // seed the local frame at the first point (a raw 0,0,0 may not project).
    const to = cloud.origin ? map(ox, oy, oz) : map(positions[0], positions[1], positions[2]);
    if (!to || to.length < 3 || !to.every(Number.isFinite)) return null;
    const out = new Float32Array(pointCount * 3);
    const min: Triple = [Infinity, Infinity, Infinity];
    const max: Triple = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pointCount * 3; i += 3) {
      const aligned = map(positions[i] + ox, positions[i + 1] + oy, positions[i + 2] + oz);
      if (!aligned) return null;
      for (let axis = 0; axis < 3; axis++) {
        const residual = Math.fround(aligned[axis] - to[axis]);
        if (!Number.isFinite(residual)) return null;
        out[i + axis] = residual;
        min[axis] = Math.min(min[axis], residual);
        max[axis] = Math.max(max[axis], residual);
      }
      extend(to[0] + out[i], to[1] + out[i + 1], to[2] + out[i + 2]);
    }
    staged.push({ cloud, origin: [to[0], to[1], to[2]], chunk: { ...cloud.chunk, positions: out, bbox: { min, max } } });
  }
  return staged;
}

export function commitInlineClouds(staged: readonly StagedCloud[]): void {
  for (const { cloud, origin, chunk } of staged) {
    cloud.origin = origin;
    cloud.chunk = chunk;
  }
}

export type InlineCloudSnapshot = NonNullable<PreAlignmentSnapshot['clouds']>;

/** Capture each cloud's origin and chunk (by reference: commits replace, never mutate). */
export function captureInlineClouds(clouds: readonly PointCloudAsset[] | undefined): InlineCloudSnapshot {
  return (clouds ?? []).map((cloud) => ({ origin: cloud.origin ? [...cloud.origin] : undefined, chunk: cloud.chunk }));
}

export function restoreInlineClouds(clouds: readonly PointCloudAsset[] | undefined, saved: InlineCloudSnapshot | undefined): void {
  if (!saved) return;
  (clouds ?? []).forEach((cloud, i) => {
    if (i >= saved.length) return;
    cloud.chunk = saved[i].chunk;
    if (saved[i].origin) cloud.origin = [...saved[i].origin!];
    else delete cloud.origin;
  });
}
