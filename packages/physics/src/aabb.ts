/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AABB, PhysicsMesh } from './types.js';

export function meshAABB(mesh: PhysicsMesh): AABB | null {
  const positions = mesh.positions;
  // Fail closed on malformed buffers — physics world construction
  // downstream assumes triplets and finite coordinates.
  if (!positions || positions.length < 3 || positions.length % 3 !== 0) {
    return null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return null;
    }
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return null;
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

export function aabbCenter(b: AABB): [number, number, number] {
  return [
    0.5 * (b.min[0] + b.max[0]),
    0.5 * (b.min[1] + b.max[1]),
    0.5 * (b.min[2] + b.max[2]),
  ];
}

export function aabbTouches(a: AABB, b: AABB, eps: number): boolean {
  return (
    a.min[0] - eps <= b.max[0] && a.max[0] + eps >= b.min[0] &&
    a.min[1] - eps <= b.max[1] && a.max[1] + eps >= b.min[1] &&
    a.min[2] - eps <= b.max[2] && a.max[2] + eps >= b.min[2]
  );
}
