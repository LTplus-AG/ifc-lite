/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * View-frustum planes from a view-projection matrix (Gribb/Hartmann), for
 * WebGPU clip space: x, y in [-w, w], z in [0, w]. Works for forward and
 * reverse Z alike (the two depth planes just swap meaning) and drops a
 * degenerate plane, which is what an infinite far plane produces.
 */

import type { PointCloudBBox } from '../types.js';

/** `[a, b, c, d]`: a point p is inside when `a*x + b*y + c*z + d >= 0`. */
export type Plane = [number, number, number, number];

/** Column-major 4x4 element (row r, column c). */
function at(m: ArrayLike<number>, r: number, c: number): number {
  return m[c * 4 + r];
}

export function frustumPlanes(viewProj: ArrayLike<number>): Plane[] {
  const row = (r: number): Plane => [at(viewProj, r, 0), at(viewProj, r, 1), at(viewProj, r, 2), at(viewProj, r, 3)];
  const [r0, r1, r2, r3] = [row(0), row(1), row(2), row(3)];
  const add = (a: Plane, b: Plane, s: number): Plane => [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2], a[3] + s * b[3]];
  const candidates: Plane[] = [
    add(r3, r0, 1), add(r3, r0, -1), // left, right
    add(r3, r1, 1), add(r3, r1, -1), // bottom, top
    r2, add(r3, r2, -1), // z >= 0, z <= w
  ];
  const planes: Plane[] = [];
  for (const p of candidates) {
    const len = Math.hypot(p[0], p[1], p[2]);
    if (!(len > 1e-12) || !Number.isFinite(len)) continue;
    planes.push([p[0] / len, p[1] / len, p[2] / len, p[3] / len]);
  }
  return planes;
}

/** False only when the box lies entirely outside one plane (conservative). */
export function boxIntersectsFrustum(box: PointCloudBBox, planes: readonly Plane[]): boolean {
  for (const [a, b, c, d] of planes) {
    // The box corner furthest along the plane normal.
    const x = a >= 0 ? box.max[0] : box.min[0];
    const y = b >= 0 ? box.max[1] : box.min[1];
    const z = c >= 0 ? box.max[2] : box.min[2];
    if (a * x + b * y + c * z + d < 0) return false;
  }
  return true;
}
