/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import type { MeshData } from '@ifc-lite/geometry';
import { perfCount, perfTally } from '@ifc-lite/load-trace';
import type { FederatedModel } from '@/store';
import { stampModelIndex } from '@/lib/model-placement/model-indices';
import { carryReleasedMesh } from '@/lib/released-mesh-provenance';

const NO_MESHES: MeshData[] = [];

/**
 * Every loaded model's meshes, hidden models included, for the scene rebuild
 * to borrow appearance sources from (#4404). Only stable renderer ownership is
 * stamped. Moved out of `Viewport` (#7021); `viewer.appearanceSource` counts
 * the meshes each rebuild of the multi-model list visits and `.copies` the
 * ones it had to copy to stamp a model index.
 */
export function useAppearanceSourceGeometry(
  models: ReadonlyMap<string, FederatedModel>,
  modelIdToIndex: ReadonlyMap<string, number> | undefined,
  geometryContentVersion: number | undefined,
): MeshData[] {
  return useMemo(() => {
    // One model: its own array, stamped in place, so a streamed append costs
    // O(new meshes) here and the list keeps its identity (#7021).
    if (models.size === 1) {
      const [modelId, model] = models.entries().next().value!;
      const meshes = model.geometryResult?.meshes;
      return meshes ? stampModelIndex(meshes, modelIdToIndex?.get(modelId) ?? 0) : NO_MESHES;
    }
    const sources: MeshData[] = [];
    let copies = 0;
    for (const [modelId, model] of models) {
      const modelIndex = modelIdToIndex?.get(modelId) ?? 0;
      for (const mesh of model.geometryResult?.meshes ?? []) {
        if (mesh.modelIndex === modelIndex) sources.push(mesh);
        else { sources.push(carryReleasedMesh(mesh, { ...mesh, modelIndex })); copies++; }
      }
    }
    perfTally('viewer.appearanceSource', sources.length, 'meshes');
    perfCount('viewer.appearanceSource.copies', copies);
    return sources;
  }, [models, modelIdToIndex, geometryContentVersion]);
}
