/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer's rebuild for a GPU device loss after CPU geometry was released
 * (#10264), registered with `Renderer.setReleasedSceneRebuild`. The renderer
 * has replaced the device and reset the scene (placements kept); this puts back
 * exactly what the scene drew, without restoring any CPU geometry:
 *
 * - flat: the list the scene last drew (`currentSceneGeometry`), resident
 *   meshes as they are and released ones from their model's acknowledged
 *   backing, in bounded batches through `replayReleasedGeometry`, each placed
 *   at the current Exploded lift as an arriving mesh would be;
 * - instanced: every model's backed shards (ids already in the federated id
 *   space), lifted the same way, uploaded with `Scene.addInstancedShard` under
 *   the model's current index.
 *
 * Fail closed: a model whose instancing is lost (its occurrences may have moved
 * since they were backed) or has no acknowledged backing makes the rebuild
 * incomplete, so the renderer reports a failed recovery instead of drawing a
 * stale or partial scene. Every step checks the recovery fence.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { DecodedInstancedShard } from '@ifc-lite/geometry';
import type { ReleasedSceneRebuild } from '@ifc-lite/renderer';
import { currentLevelYForModels, liftNewInstancedOccurrences, placeNewMeshesAtCurrentLevel } from '@/lib/level-arrival';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { getViewerState } from '@/store/viewerStoreHandle';
import { hasInstancedShards } from '@/store/instancedShardModels';
import { activeGeometryBackingTap } from './backing-debug-hook';
import { currentSceneGeometry, releasedBatches, releasedReplayEpoch } from './released-scene-replay';

/** A private copy: the lift moves transforms, and the reader may hand the same decode out again. */
function liftedCopy(shard: DecodedInstancedShard, lift: ReadonlyMap<number, number>): DecodedInstancedShard {
  const copy = { ...shard, instances: shard.instances.map((instance) => ({ ...instance, transform: instance.transform.slice() })) };
  liftNewInstancedOccurrences(copy, lift);
  return copy;
}

/** What the rebuild was taken from: any change while it awaits the backing makes it stale. */
function viewerSource(state: ReturnType<typeof getViewerState>): unknown[] {
  return [releasedReplayEpoch(), state.geometryContentVersion, currentSceneGeometry(),
    ...[...state.models].flatMap(([id, model]) => [id, model.geometryResult, model.idOffset])];
}

export const rebuildReleasedScene: ReleasedSceneRebuild = async ({ device, pipeline, scene, isCurrent: deviceCurrent, requestRender }) => {
  const tap = activeGeometryBackingTap();
  if (!tap) return false;
  const state = getViewerState();
  // Fenced by the renderer (device, generation) AND by the viewer: a model replaced, a content
  // version moved or a new drawn list while a chunk was read must not publish the old source.
  const source = viewerSource(state);
  const isCurrent = () => {
    if (!deviceCurrent()) return false;
    const now = viewerSource(getViewerState());
    return now.length === source.length && now.every((value, i) => value === source[i]);
  };
  const lift = currentLevelYForModels(state.models, state.appliedEntityLevelOffsets);
  const statuses = new Map(tap.status().map((row) => [row.modelId, row]));
  for (const modelId of state.models.keys()) {
    if (statuses.get(modelId)?.instancedLost) {
      console.warn(`[GeometryBacking] ${modelId}: instancing is lost; a released device recovery would draw stale occurrences`);
      return false;
    }
  }
  const { replayReleasedGeometry } = await import('@ifc-lite/renderer');
  const flat = await releasedBatches(currentSceneGeometry().slice());
  async function* placed(): AsyncGenerator<MeshData[]> {
    for await (const batch of flat) yield placeNewMeshesAtCurrentLevel(batch, lift);
  }
  const replayed = await replayReleasedGeometry({ getScene: () => scene, getGPUDevice: () => (isCurrent() ? device : null),
    getPipeline: () => pipeline, requestRender }, placed(), { isCurrent });
  if (replayed.status !== 'complete') return false;
  const indices = modelIndices(state.models);
  for (const modelId of state.models.keys()) {
    const source = tap.replaySource(modelId);
    if (!hasInstancedShards(modelId)) continue;
    // The scene drew this model's instances: only its own complete backing can put them back.
    if (!source?.backing?.isCurrent || !source.backing.isComplete) return false;
    const modelIndex = indices.get(modelId);
    if (modelIndex === undefined) return false;
    for await (const shard of source.backing.reader.instancedShards()) {
      if (!isCurrent()) return false;
      scene.addInstancedShard(device, liftedCopy(shard, lift), modelIndex);
    }
  }
  requestRender();
  return isCurrent();
};
