/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import { retainReleasedMeshProvenance } from './released-mesh-provenance';

const EMPTY_POSITIONS = new Float32Array(0);
const EMPTY_NORMALS = new Float32Array(0);
const EMPTY_INDICES = new Uint32Array(0);
// Array identity survives canonical append. Weak keys retain neither a source
// array nor the CPU buffers that release intentionally discards (#6537).
const revisions = new WeakMap<readonly MeshData[], number>();

/** CPU-only invalidation; GPU geometry content version stays unchanged. */
export function cpuMeshReleaseVersion(meshes: readonly MeshData[] | undefined): number {
  return meshes ? revisions.get(meshes) ?? 0 : 0;
}

/** The canonical bounded-memory release, including batched release + append. */
export function releaseCpuMeshBuffers(meshes: MeshData[]): void {
  for (const mesh of meshes) {
    retainReleasedMeshProvenance(mesh);
    mesh.positions = EMPTY_POSITIONS;
    mesh.normals = EMPTY_NORMALS;
    mesh.indices = EMPTY_INDICES;
    delete mesh.appearanceSource;
  }
  revisions.set(meshes, cpuMeshReleaseVersion(meshes) + 1);
}
