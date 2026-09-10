/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';

// The bounded-memory release callback runs after GPU upload. Retain only
// identity, not the buffers it explicitly releases. Object lifetime is weak.
const released = new WeakMap<MeshData, { owner: number; item: number | undefined }>();
const nonempty = (mesh: MeshData) => mesh.indices.length >= 3 && mesh.positions.length >= 9;

export function retainReleasedMeshProvenance(mesh: MeshData): void {
  if (nonempty(mesh)) released.set(mesh, { owner: mesh.expressId, item: mesh.geometryItemId });
}

export function hasMeshGeometryProvenance(mesh: MeshData): boolean {
  if (nonempty(mesh)) {
    released.delete(mesh); // New populated geometry supersedes any previous release.
    return true;
  }
  const prior = released.get(mesh);
  return prior !== undefined && prior.owner === mesh.expressId && prior.item === mesh.geometryItemId;
}
