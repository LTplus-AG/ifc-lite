/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useRef } from 'react';
import type { MeshData } from '@ifc-lite/geometry';
import { perfCount, perfTally } from '@ifc-lite/load-trace';
import type { FederatedModel } from '@/store';
import { stampModelIndex } from '@/lib/model-placement/model-indices';

const NO_MESHES: MeshData[] = [];

interface Source {
  id: string;
  meshes: MeshData[];
  length: number;
  index: number;
}
interface SourceCache {
  sources: Source[];
  meshes: MeshData[];
  version: number | undefined;
}

/**
 * Every loaded model's meshes, hidden models included, for the scene rebuild
 * to borrow appearance sources from (#4404). Only stable renderer ownership is
 * stamped, using the canonical producer objects. Keep model-grouped order:
 * this list does not share the visible cache's chronological upload prefix.
 * `viewer.appearanceSource.meshes` counts visited source references; earlier
 * model appends also move suffix pointers, counted separately (#6537).
 */
export function useAppearanceSourceGeometry(
  models: ReadonlyMap<string, FederatedModel>,
  modelIdToIndex: ReadonlyMap<string, number> | undefined,
  geometryContentVersion: number | undefined,
): MeshData[] {
  const cacheRef = useRef<SourceCache | null>(null);
  return useMemo(() => {
    // Do not retain departed multi-model geometry when returning to one/zero.
    if (models.size <= 1) cacheRef.current = null;
    // One model: its own array, stamped in place, so a streamed append costs
    // O(new meshes) here and the list keeps its identity (#7021).
    if (models.size === 1) {
      const [modelId, model] = models.entries().next().value!;
      const meshes = model.geometryResult?.meshes;
      return meshes ? stampModelIndex(meshes, modelIdToIndex?.get(modelId) ?? 0) : NO_MESHES;
    }
    if (!models.size) return NO_MESHES;

    const sources: Source[] = [];
    for (const [modelId, model] of models) {
      const meshes = model.geometryResult?.meshes ?? NO_MESHES;
      sources.push({ id: modelId, meshes, length: meshes.length,
        index: modelIdToIndex?.get(modelId) ?? 0 });
    }
    const cache = cacheRef.current;
    const rebuild = !cache || cache.version !== geometryContentVersion
      || cache.sources.length !== sources.length || sources.some((source, i) => {
        const previous = cache.sources[i];
        return previous.id !== source.id || previous.meshes !== source.meshes
          || previous.index !== source.index || previous.length > source.length;
      });
    if (rebuild) {
      const meshes: MeshData[] = [];
      for (const source of sources) {
        stampModelIndex(source.meshes, source.index);
        for (const mesh of source.meshes) meshes.push(mesh);
      }
      cacheRef.current = { sources, meshes, version: geometryContentVersion };
      if (meshes.length) perfTally('viewer.appearanceSource', meshes.length, 'meshes');
      return meshes;
    }

    let offset = 0;
    let visited = 0;
    let shifted = 0;
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      const previousLength = cache.sources[i].length;
      const added = source.length - previousLength;
      stampModelIndex(source.meshes, source.index);
      if (added > 0) {
        const insert = offset + previousLength;
        const oldLength = cache.meshes.length;
        const suffix = oldLength - insert;
        cache.meshes.length = oldLength + added;
        // No spread/splice arguments: real batches can exceed argument limits.
        // Last-model appends move no retained meshes. Earlier appends keep the
        // existing model order at O(suffix + new), without mesh wrapper copies.
        if (suffix > 0) cache.meshes.copyWithin(insert + added, insert, oldLength);
        for (let j = previousLength; j < source.length; j++) {
          cache.meshes[offset + j] = source.meshes[j];
        }
        visited += added;
        shifted += suffix;
      }
      offset += source.length;
    }
    cache.sources = sources;
    if (visited) perfTally('viewer.appearanceSource', visited, 'meshes');
    if (shifted) perfCount('viewer.appearanceSource.shiftedMeshes', shifted);
    return cache.meshes;
  }, [models, modelIdToIndex, geometryContentVersion]);
}
