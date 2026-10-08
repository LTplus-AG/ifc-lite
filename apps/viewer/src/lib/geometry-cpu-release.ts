/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import { cpuMeshAliases } from './geometry-cpu-aliases';
import { meshCpuBuffers, sharesCpuBuffer } from './geometry-cpu-buffers';
import { retainReleasedMeshProvenance } from './released-mesh-provenance';

const EMPTY_POSITIONS = new Float32Array(0);
const EMPTY_NORMALS = new Float32Array(0);
const EMPTY_INDICES = new Uint32Array(0);
/** Canonical CPU-only release; preserve independent fields on derived copies. */
export function releaseCpuMeshBuffers(meshes: MeshData[]): void {
  for (const mesh of meshes) {
    const buffers = meshCpuBuffers(mesh);
    for (const alias of cpuMeshAliases(mesh)) {
      const positionsShared = sharesCpuBuffer(alias.positions, buffers);
      const normalsShared = sharesCpuBuffer(alias.normals, buffers);
      const indicesShared = sharesCpuBuffer(alias.indices, buffers);
      const appearance = alias.appearanceSource;
      const appearanceIndicesShared = sharesCpuBuffer(appearance?.indices, buffers);
      const appearanceSourceShared = sharesCpuBuffer(appearance?.sourceIndices, buffers);
      const appearanceCornersShared = sharesCpuBuffer(appearance?.cornerIndices, buffers);
      if (!positionsShared && !normalsShared && !indicesShared
        && !appearanceIndicesShared && !appearanceSourceShared && !appearanceCornersShared) continue;
      retainReleasedMeshProvenance(alias, {
        ...(positionsShared ? { positions: EMPTY_POSITIONS } : {}),
        ...(indicesShared ? { indices: EMPTY_INDICES } : {}),
      });
      if (positionsShared) alias.positions = EMPTY_POSITIONS;
      if (normalsShared) alias.normals = EMPTY_NORMALS;
      if (indicesShared) alias.indices = EMPTY_INDICES;
      if (appearance) {
        if (appearanceIndicesShared && appearanceSourceShared && (!appearance.cornerIndices || appearanceCornersShared)) {
          delete alias.appearanceSource;
        } else if (appearanceIndicesShared || appearanceSourceShared || appearanceCornersShared) {
          alias.appearanceSource = { ...appearance,
            ...(appearanceIndicesShared ? { indices: EMPTY_INDICES } : {}),
            ...(appearanceSourceShared ? { sourceIndices: EMPTY_INDICES } : {}),
            // Keep an explicit empty fence: dropping the mapping would imply
            // identity correspondence and could fabricate an editable triangle.
            ...(appearanceCornersShared ? { cornerIndices: EMPTY_INDICES } : {}),
          };
        }
      }
    }
  }
}
