/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { perfTally } from '@ifc-lite/load-trace';

/** Retained GPU instance templates must keep their owner index after another
 * model is removed. Never compact indices in a live federation.
 *
 * The returned map is shared until an assignment changes (#7021): a streamed
 * append re-creates the store's `models` map, and a fresh index map per append
 * re-ran every memo keyed on it. Treat it as read-only. */
export function createModelIndexAllocator() {
  let next = 0;
  const assigned = new Map<string, number>();
  let snapshot = new Map<string, number>();
  return (models: ReadonlyMap<string, unknown>): Map<string, number> => {
    let changed = false;
    if (!models.size && (assigned.size || next)) { assigned.clear(); next = 0; changed = true; }
    for (const id of assigned.keys()) if (!models.has(id)) { assigned.delete(id); changed = true; }
    for (const id of models.keys()) if (!assigned.has(id)) { assigned.set(id, next++); changed = true; }
    if (changed) snapshot = new Map(assigned);
    return snapshot;
  };
}
export const modelIndices = createModelIndexAllocator();

/** How far each mesh array has been stamped, and with which index. */
const stamped = new WeakMap<readonly MeshData[], { index: number; length: number }>();

/**
 * Stamp `index` onto the meshes of one model's own array, in place, and return
 * that same array (#7021). Streaming appends push onto the array without
 * changing its identity, so only the meshes added since the previous call are
 * visited: O(new meshes) per append instead of a copy of every mesh. A new
 * array (a replacement), a shorter one or a different index starts over.
 * `viewer.modelIndexStamp` counts the meshes visited.
 */
export function stampModelIndex<T extends MeshData[]>(meshes: T, index: number): T {
  const seen = stamped.get(meshes);
  const from = seen && seen.index === index && seen.length <= meshes.length ? seen.length : 0;
  for (let i = from; i < meshes.length; i++) {
    if (meshes[i].modelIndex !== index) meshes[i].modelIndex = index;
  }
  if (meshes.length > from) perfTally('viewer.modelIndexStamp', meshes.length - from, 'meshes');
  stamped.set(meshes, { index, length: meshes.length });
  return meshes;
}

/**
 * One model's geometry as the viewport renders it: the model's own mesh array
 * with `index` stamped in place, so its identity survives streaming appends and
 * the filters downstream stay incremental (#7021). The old per-call copy of
 * every mesh is what `viewer.modelIndexRespread` counted; for a single model it
 * now stays at zero. Point clouds are few and keep their copy-on-mismatch.
 */
export function geometryWithModelIndex(geometry: GeometryResult | null, index: number): GeometryResult | null {
  if (!geometry) return null;
  stampModelIndex(geometry.meshes, index);
  const clouds = geometry.pointClouds;
  if (!clouds?.some((asset) => asset.modelIndex !== index)) return geometry;
  return { ...geometry, pointClouds: clouds.map((asset) => (asset.modelIndex === index ? asset : { ...asset, modelIndex: index })) };
}
