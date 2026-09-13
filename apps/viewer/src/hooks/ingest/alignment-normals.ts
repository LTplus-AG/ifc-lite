/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AffineTransform3D } from './federationAlignAabb.js';

/** Apply the inverse transpose of a nonuniform Y-up alignment transform. */
export function alignNormals(normals: Float32Array | number[], transform: AffineTransform3D): void {
  const det = transform.m00 * transform.m22 - transform.m02 * transform.m20;
  if (Math.abs(det) < 1e-12 || Math.abs(transform.m11) < 1e-12) return;
  for (let i = 0; i < normals.length; i += 3) {
    const [nx, ny, nz] = [normals[i]!, normals[i + 1]!, normals[i + 2]!];
    if (![nx, ny, nz].every(Number.isFinite)) continue;
    const rx = (transform.m22 * nx - transform.m20 * nz) / det;
    const ry = ny / transform.m11;
    const rz = (-transform.m02 * nx + transform.m00 * nz) / det;
    const len = Math.hypot(rx, ry, rz);
    if (!Number.isFinite(len) || len < 1e-12) continue;
    normals[i] = rx / len;
    normals[i + 1] = ry / len;
    normals[i + 2] = rz / len;
  }
}
