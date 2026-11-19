/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The live viewer's `DrawingGeometry` for one drawing request (#10264): the
 * store's models, placement and federation, the renderer's instanced
 * occurrences, and, only when something was released, the backing the
 * (test/debug-only) tap keeps. That module is loaded on demand, so a resident
 * drawing never pulls the backing stack into its bundle.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { displayedTranslation } from '@/lib/model-placement/state';
import { sceneGeometryReleased } from '@/lib/geometry-backing/scene-released';
import { hasInstancedShards } from '@/store/instancedShardModels';
import { GeometryUnavailableError, meshIsResident } from '@/lib/geometry-backing/geometry-readback';
import type { ModelGeometryBacking } from '@/lib/geometry-backing/geometry-backing-registry';
import { DrawingGeometry } from './drawing-geometry-source';

export async function liveDrawingGeometry(meshes: readonly MeshData[], isCurrent: () => boolean,
  renderer: Renderer | null = getGlobalRenderer()): Promise<DrawingGeometry> {
  const state = useViewerStore.getState();
  const instancedReleased = renderer ? sceneGeometryReleased(renderer) : false;
  let backing: (modelId: string) => ModelGeometryBacking | undefined = () => undefined;
  if (instancedReleased || !meshes.every(meshIsResident)) {
    const { activeGeometryBackingTap } = await import('@/lib/geometry-backing/backing-debug-hook');
    const tap = activeGeometryBackingTap();
    backing = (modelId) => tap?.backing(modelId);
  }
  // Without a renderer no instanced occurrence can be materialized: refuse rather than draw without them.
  if (!renderer && [...state.models].some(([id, model]) => model.visible && hasInstancedShards(id))) {
    throw new GeometryUnavailableError('Instanced geometry cannot be drawn before the viewport renderer exists');
  }
  const indices = modelIndices(state.models);
  // Legacy single-model mode keeps no `models` entry: everything is one model.
  const legacy = state.models.size === 0;
  return new DrawingGeometry(meshes, {
    modelOf: (globalId) => {
      const { modelId } = resolveEntityRef(globalId);
      return legacy || state.models.has(modelId) ? modelId : undefined;
    },
    visibleModels: legacy ? ['legacy'] : [...state.models].filter(([, model]) => model.visible).map(([id]) => id),
    modelIndexOf: (modelId) => indices.get(modelId) ?? 0,
    translationFor: (modelId) => displayedTranslation(state.modelPlacement, modelId),
    typeOf: (globalId) => {
      const ref = resolveEntityRef(globalId);
      const store = legacy ? state.ifcDataStore : state.models.get(ref.modelId)?.ifcDataStore;
      return store?.entities.getTypeName(ref.expressId) || undefined;
    },
    scene: renderer && !instancedReleased ? renderer.getScene() : null,
    instancedReleased,
    hasInstanced: (modelId) => hasInstancedShards(modelId),
    backing,
    isCurrent,
  });
}
