/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import type { MeshData } from '@ifc-lite/geometry';
import { perfCount, perfTally } from '@ifc-lite/load-trace';
import type { FederatedModel } from '@/store';

/**
 * Every loaded model's meshes, hidden models included, for the scene rebuild
 * to borrow appearance sources from (#4404). Only stable renderer ownership is
 * stamped. Moved out of `Viewport` (#7021); `viewer.appearanceSource` counts
 * the meshes each rebuild of this list visits and `.copies` the ones it had
 * to copy to stamp a model index.
 */
export function useAppearanceSourceGeometry(
  models: ReadonlyMap<string, FederatedModel>,
  modelIdToIndex: ReadonlyMap<string, number> | undefined,
  geometryContentVersion: number | undefined,
): MeshData[] {
  return useMemo(() => {
    const sources: MeshData[] = [];
    let copies = 0;
    for (const [modelId, model] of models) {
      const modelIndex = modelIdToIndex?.get(modelId) ?? 0;
      for (const mesh of model.geometryResult?.meshes ?? []) {
        if (mesh.modelIndex === modelIndex) sources.push(mesh);
        else { sources.push({ ...mesh, modelIndex }); copies++; }
      }
    }
    perfTally('viewer.appearanceSource', sources.length, 'meshes');
    perfCount('viewer.appearanceSource.copies', copies);
    return sources;
  }, [models, modelIdToIndex, geometryContentVersion]);
}
