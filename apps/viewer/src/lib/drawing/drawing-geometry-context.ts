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
import { federationRegistry } from '@ifc-lite/renderer';
import { useViewerStore, type EntityRef, type ViewerState } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { displayedTranslation } from '@/lib/model-placement/state';
import { sceneGeometryReleased } from '@/lib/geometry-backing/scene-released';
import { hasInstancedShards } from '@/store/instancedShardModels';
import { meshIsResident } from '@/lib/geometry-backing/geometry-readback';
import type { ModelGeometryBacking } from '@/lib/geometry-backing/geometry-backing-registry';
import { DrawingGeometry } from './drawing-geometry-source';

// Loaded with this module on first drawing (`useDrawingGeneration`).
export { drawingMeshFilter } from './drawing-mesh-filter';

/**
 * The model (and local id) owning a global id by its registered range, or the
 * progressive registry's; `resolveEntityRef` would hand an id outside every
 * range to the first model. Only one model at offset zero, or legacy mode,
 * owns any id. Model choice and class lookup both go through this one lookup.
 */
export function drawingEntityOf(state: Pick<ViewerState, 'models' | 'resolveGlobalIdFromModels'>, globalId: number): EntityRef | undefined {
  if (state.models.size === 0) return { modelId: 'legacy', expressId: globalId };
  const ref = state.resolveGlobalIdFromModels(globalId) ?? federationRegistry.fromGlobalId(globalId);
  if (ref) return state.models.has(ref.modelId) ? { modelId: ref.modelId, expressId: ref.expressId } : undefined;
  const [only] = state.models;
  return state.models.size === 1 && only[1].idOffset === 0 ? { modelId: only[0], expressId: globalId } : undefined;
}

export const drawingModelOf = (state: Pick<ViewerState, 'models' | 'resolveGlobalIdFromModels'>, globalId: number): string | undefined =>
  drawingEntityOf(state, globalId)?.modelId;

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
  // The caller has already asserted every instanced occurrence is visible (`assertInstancedReady`), on this state.
  const indices = modelIndices(state.models);
  // Legacy single-model mode keeps no `models` entry: everything is one model.
  const legacy = state.models.size === 0;
  return new DrawingGeometry(meshes, {
    modelOf: (globalId) => drawingModelOf(state, globalId),
    visibleModels: legacy ? ['legacy'] : [...state.models].filter(([, model]) => model.visible).map(([id]) => id),
    modelIndexOf: (modelId) => indices.get(modelId) ?? 0,
    translationFor: (modelId) => displayedTranslation(state.modelPlacement, modelId),
    typeOf: (globalId) => {
      const ref = drawingEntityOf(state, globalId);
      const store = legacy ? state.ifcDataStore : ref && state.models.get(ref.modelId)?.ifcDataStore;
      return (ref && store?.entities.getTypeName(ref.expressId)) || undefined;
    },
    scene: renderer && !instancedReleased ? renderer.getScene() : null,
    instancedReleased,
    hasInstanced: (modelId) => hasInstancedShards(modelId),
    // The scene keeps listing its instanced entities after releasing their templates.
    listedInstanced: renderer && instancedReleased ? () => renderer.getScene().getInstancedEntityIds() : undefined,
    backing,
    isCurrent,
  });
}
