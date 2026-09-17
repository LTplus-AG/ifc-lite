/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';

// The bounded-memory release callback runs after GPU upload. Retain only
// identity, not the buffers it explicitly releases. Object lifetime is weak.
const released = new WeakMap<MeshData, { owner: number; item: number | undefined }>();
const nonempty = (mesh: MeshData) => mesh.indices.length >= 3 && mesh.positions.length >= 9;

// Triangle/vertex counts the running geometryResult totals still include for a
// released mesh, so removing it later subtracts what was added (#4874).
const releasedCounts = new WeakMap<MeshData, MeshGeometryCounts>();

export interface MeshGeometryCounts { triangles: number; vertices: number }

export function retainReleasedMeshProvenance(mesh: MeshData): void {
  if (nonempty(mesh)) released.set(mesh, { owner: mesh.expressId, item: mesh.geometryItemId });
  // Only a populated mesh has counts to retain: releasing an already-released
  // mesh must not overwrite them with zero.
  if (mesh.indices.length > 0 || mesh.positions.length > 0) {
    releasedCounts.set(mesh, { triangles: mesh.indices.length / 3, vertices: mesh.positions.length / 3 });
  }
}

/**
 * Carry a released mesh's retained provenance and counts onto a copy of it
 * (e.g. `updateMeshColors`' `{ ...mesh, color }`), whose buffers are just as
 * empty but which the WeakMaps would not otherwise know. Returns `copy`.
 */
export function carryReleasedMesh(source: MeshData, copy: MeshData): MeshData {
  const provenance = released.get(source);
  if (provenance) released.set(copy, provenance);
  const counts = releasedCounts.get(source);
  if (counts) releasedCounts.set(copy, counts);
  return copy;
}

/** Counts this mesh contributes to geometryResult totals, live or as retained at release. */
export function meshGeometryCounts(mesh: MeshData): MeshGeometryCounts {
  if (mesh.indices.length > 0 || mesh.positions.length > 0) {
    return { triangles: mesh.indices.length / 3, vertices: mesh.positions.length / 3 };
  }
  return releasedCounts.get(mesh) ?? { triangles: 0, vertices: 0 };
}

export function hasMeshGeometryProvenance(mesh: MeshData): boolean {
  if (nonempty(mesh)) {
    released.delete(mesh); // New populated geometry supersedes any previous release.
    return true;
  }
  const prior = released.get(mesh);
  return prior !== undefined && prior.owner === mesh.expressId && prior.item === mesh.geometryItemId;
}
