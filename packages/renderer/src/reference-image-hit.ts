/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Ray } from './raycaster.js';
import type { ReferenceCorners, ReferenceImageHit, ReferencePoint } from './reference-image-types.js';

const subtract = (a: ReferencePoint, b: ReferencePoint): ReferencePoint => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const cross = (a: ReferencePoint, b: ReferencePoint): ReferencePoint => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot = (a: ReferencePoint, b: ReferencePoint): number => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

/** Quad interaction only; does not generate, transform or classify IFC geometry. */
export function referenceImageHit(id: string, corners: ReferenceCorners, ray: Ray, maxDistance: number): ReferenceImageHit | null {
  const origin: ReferencePoint = [ray.origin.x, ray.origin.y, ray.origin.z];
  const direction: ReferencePoint = [ray.direction.x, ray.direction.y, ray.direction.z];
  let closest: ReferenceImageHit | null = null;
  for (const indices of [[0,1,2], [0,2,3]]) {
    const a = corners[indices[0]], edge1 = subtract(corners[indices[1]], a), edge2 = subtract(corners[indices[2]], a);
    const p = cross(direction, edge2), determinant = dot(edge1, p);
    if (!Number.isFinite(determinant) || Math.abs(determinant) <= Number.EPSILON * Math.hypot(...edge1) * Math.hypot(...edge2)) continue;
    const t = subtract(origin, a), u = dot(t, p) / determinant;
    if (u < 0 || u > 1) continue;
    const q = cross(t, edge1), v = dot(direction, q) / determinant;
    if (v < 0 || u + v > 1) continue;
    const distance = dot(edge2, q) / determinant;
    if (!Number.isFinite(distance) || distance < 0 || distance >= maxDistance) continue;
    maxDistance = distance;
    closest = { referenceId: id, distance, point: [origin[0]+direction[0]*distance, origin[1]+direction[1]*distance, origin[2]+direction[2]*distance] };
  }
  return closest;
}
