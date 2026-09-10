/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import { hasMeshGeometryProvenance } from '@/lib/released-mesh-provenance';

/** The loader globalizes mesh owner AND item ids. Symbolic ids remain local;
 * the model-bound canonical mapper is required for both sides of that key. */
export function meshedFillItems(meshes: readonly MeshData[] | undefined, toGlobalId: (id: number) => number) {
  const owners = new Map<number, Set<number>>();
  for (const mesh of meshes ?? []) {
    const item = mesh.geometryItemId;
    if (item === undefined || !hasMeshGeometryProvenance(mesh)) continue;
    let items = owners.get(mesh.expressId);
    if (!items) owners.set(mesh.expressId, items = new Set());
    items.add(item);
  }
  return (owner: number, item: number) => owners.get(toGlobalId(owner))?.has(toGlobalId(item)) ?? false;
}
