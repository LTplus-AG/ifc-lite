/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AffineTransform3D } from './federationAlignAabb.js';

/** Apply the inverse transpose of a nonuniform Y-up alignment transform. */
export function alignNormals(normals: Float32Array | number[], transform: AffineTransform3D): void {
  const det = transform.m00 * transform.m22 - transform.m02 * transform.m20;
  if (Math.abs(det) < 1e-12 || Math.abs(transform.m11) < 1e-12) return;
  // Per vertex: no tuples, no divisions.
  const xx = transform.m22 / det, xz = -transform.m20 / det;
  const zx = -transform.m02 / det, zz = transform.m00 / det;
  const yy = 1 / transform.m11;
  for (let i = 0; i < normals.length; i += 3) {
    const nx = normals[i]!, ny = normals[i + 1]!, nz = normals[i + 2]!;
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) continue;
    const rx = xx * nx + xz * nz;
    const ry = yy * ny;
    const rz = zx * nx + zz * nz;
    const len = Math.hypot(rx, ry, rz);
    if (!Number.isFinite(len) || len < 1e-12) continue;
    normals[i] = rx / len;
    normals[i + 1] = ry / len;
    normals[i + 2] = rz / len;
  }
}
