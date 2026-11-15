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
import { applyAffineTransform, type AffineTransform3D, type WorldPointMap } from './federationAlignAabb.js';

type Triple = [number, number, number];

export interface StagedCloud {
  cloud: PointCloudAsset;
  origin: Triple;
  chunk: PointCloudAsset['chunk'];
}

/** Map every inline cloud; `null` when any point cannot be mapped or narrowed.
 * `extend` receives each staged cloud's two world bbox corners (f64 origin +
 * f32 residual bounds), which bound its aligned points exactly.
 * `onPointMapped` reports each point's reprojection, as the mesh vertex loop
 * counts its vertices: origin setup, missing (NaN) points and an f32 overflow
 * are not reprojection attempts. The affine (same-CRS) path reports nothing. */
export function stageInlineClouds(
  clouds: readonly PointCloudAsset[] | undefined, mapping: WorldPointMap | AffineTransform3D, extend: (x: number, y: number, z: number) => void,
  onPointMapped?: (succeeded: boolean) => void,
): StagedCloud[] | null {
  const transform = typeof mapping === 'function' ? undefined : mapping;
  const map: WorldPointMap = typeof mapping === 'function' ? mapping : (x, y, z) => applyAffineTransform(mapping, x, y, z);
  const staged: StagedCloud[] = [];
  for (const cloud of clouds ?? []) {
    const { positions, pointCount } = cloud.chunk;
    if (pointCount === 0) continue; // a streamed scan's descriptor: aligned by its own registry
    const [ox, oy, oz] = cloud.origin ?? [0, 0, 0];
    // An organized scan marks a missing point with NaN; it stays NaN (not drawn,
    // not in the bbox) instead of refusing the whole model's alignment.
    const valid = (i: number) => Number.isFinite(positions[i]) && Number.isFinite(positions[i + 1]) && Number.isFinite(positions[i + 2]);
    let first = 0;
    while (first < pointCount * 3 && !valid(first)) first += 3;
    if (first === pointCount * 3) continue; // nothing to align
    // Like the mesh paths: transform the origin when there is one, otherwise
    // seed the local frame at the first point (a raw 0,0,0 may not project).
    const to = cloud.origin ? map(ox, oy, oz) : map(positions[first], positions[first + 1], positions[first + 2]);
    if (!to || !to.every(Number.isFinite)) return null;
    const [tx, ty, tz] = to;
    const out = new Float32Array(pointCount * 3).fill(NaN);
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = first; i < pointCount * 3; i += 3) {
      if (!valid(i)) continue;
      const x = positions[i] + ox, y = positions[i + 1] + oy, z = positions[i + 2] + oz;
      let ax: number, ay: number, az: number;
      if (transform) {
        // Same f64 operation order as applyAffineTransform, without a call or
        // tuple allocation per point (#10094, 3f).
        ax = transform.m00 * x + transform.m01 * y + transform.m02 * z + transform.tx;
        ay = transform.m10 * x + transform.m11 * y + transform.m12 * z + transform.ty;
        az = transform.m20 * x + transform.m21 * y + transform.m22 * z + transform.tz;
      } else {
        const aligned = map(x, y, z);
        onPointMapped?.(aligned !== null);
        if (!aligned) return null;
        [ax, ay, az] = aligned;
      }
      const rx = Math.fround(ax - tx), ry = Math.fround(ay - ty), rz = Math.fround(az - tz);
      if (!Number.isFinite(rx) || !Number.isFinite(ry) || !Number.isFinite(rz)) return null;
      out[i] = rx; out[i + 1] = ry; out[i + 2] = rz;
      if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
      if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
      if (rz < minZ) minZ = rz; if (rz > maxZ) maxZ = rz;
    }
    extend(tx + minX, ty + minY, tz + minZ);
    extend(tx + maxX, ty + maxY, tz + maxZ);
    staged.push({ cloud, origin: [tx, ty, tz], chunk: { ...cloud.chunk, positions: out, bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } } });
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
