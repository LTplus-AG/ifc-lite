/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';

/** Texture baking may duplicate vertices but cannot change ordered triangle
 * corners or their owner/item identity. Original barycentric observations then
 * still name the same geometric point; UVs are intentionally not compared. */
export function sameLandmarkGeometry(before: MeshData, after: MeshData): boolean {
  if (before.expressId !== after.expressId || before.geometryItemId !== after.geometryItemId
    || before.indices.length !== after.indices.length) return false;
  for (let i = 0; i < before.indices.length; i++) for (let axis = 0; axis < 3; axis++) {
    const a = before.positions[before.indices[i] * 3 + axis];
    const b = after.positions[after.indices[i] * 3 + axis];
    if (a !== b || (before.origin?.[axis] ?? 0) !== (after.origin?.[axis] ?? 0)) return false;
  }
  return true;
}
