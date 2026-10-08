/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import { cpuMeshAliases } from './geometry-cpu-aliases';
import { retainReleasedMeshProvenance } from './released-mesh-provenance';

const EMPTY_POSITIONS = new Float32Array(0);
const EMPTY_NORMALS = new Float32Array(0);
const EMPTY_INDICES = new Uint32Array(0);
/** Canonical CPU-only release; preserve independent fields on derived copies. */
export function releaseCpuMeshBuffers(meshes: MeshData[]): void {
  for (const mesh of meshes) {
    const { positions, normals, indices, appearanceSource } = mesh;
    for (const alias of cpuMeshAliases(mesh)) {
      const positionsShared = alias.positions === positions;
      const normalsShared = alias.normals === normals;
      const indicesShared = alias.indices === indices;
      const appearanceShared = appearanceSource !== undefined && alias.appearanceSource === appearanceSource;
      if (!positionsShared && !normalsShared && !indicesShared && !appearanceShared) continue;
      retainReleasedMeshProvenance(alias, {
        ...(positionsShared ? { positions: EMPTY_POSITIONS } : {}),
        ...(indicesShared ? { indices: EMPTY_INDICES } : {}),
      });
      if (positionsShared) alias.positions = EMPTY_POSITIONS;
      if (normalsShared) alias.normals = EMPTY_NORMALS;
      if (indicesShared) alias.indices = EMPTY_INDICES;
      if (appearanceShared) delete alias.appearanceSource;
    }
  }
}
