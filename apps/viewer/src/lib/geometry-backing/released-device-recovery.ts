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
import { liftNewInstancedOccurrences, placeNewMeshesAtCurrentLevel } from '@/lib/level-arrival';
import { captureLevelLift } from '@/lib/level-lift-fence';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { getViewerState } from '@/store/viewerStoreHandle';
import { hasInstancedShards } from '@/store/instancedShardModels';
import { activeGeometryBackingTap } from './backing-debug-hook';
import { currentSceneGeometry, releasedBatches, releasedReplayEpoch, supersedeReleasedReplays } from './released-scene-replay';

/** A private copy: the lift moves transforms, and the reader may hand the same decode out again. */
function liftedCopy(shard: DecodedInstancedShard, lift: ReadonlyMap<number, number>): DecodedInstancedShard {
  const copy = { ...shard, instances: shard.instances.map((instance) => ({ ...instance, transform: instance.transform.slice() })) };
  liftNewInstancedOccurrences(copy, lift);
  return copy;
}

/** What the rebuild was taken from: any change while it awaits the backing makes it stale. */
function viewerSource(state: ReturnType<typeof getViewerState>): unknown[] {
  // Lengths too: a list grown in place keeps its identity but not its membership.
  const drawn = currentSceneGeometry();
  // The Exploded lift too: it is captured once and applied to every replayed and restaged piece.
  return [releasedReplayEpoch(), state.geometryContentVersion, state.appliedEntityLevelOffsets, drawn, drawn?.length,
    ...[...state.models].flatMap(([id, model]) => [id, model.geometryResult, model.geometryResult?.meshes, model.geometryResult?.meshes.length, model.idOffset])];
}

/** The same members in the same order as `snapshot`: an in-place replacement keeps a list's identity and length. */
function sameMembers(list: readonly MeshData[] | undefined, snapshot: readonly MeshData[] | undefined): boolean {
  if (!list || !snapshot) return list === snapshot;
  return list.length === snapshot.length && list.every((mesh, i) => mesh === snapshot[i]);
}

export const rebuildReleasedScene: ReleasedSceneRebuild = async ({ device, pipeline, scene, instancedModelIndices, isCurrent: deviceCurrent, requestRender }) => {
  // The renderer reset the scene: every released replay queued, running or parked before the loss
  // belongs to the old scene and must never resume into the rebuilt one (#10264).
  supersedeReleasedReplays();
  const tap = activeGeometryBackingTap();
  if (!tap) return false;
  const state = getViewerState();
  // Fenced by the renderer (device, generation) AND by the viewer: a model replaced, a content
  // version moved or a new drawn list while a chunk was read must not publish the old source.
  const source = viewerSource(state);
  // Immutable membership the rebuild is taken from: the replay uploads exactly this, and the fence compares it.
  const drawnAt = currentSceneGeometry()?.slice();
  const membersAt = new Map([...state.models].map(([id, model]) => [id, model.geometryResult?.meshes.slice()]));
  // Per restaged model, the drawn shard revision its backing was read at: a shard ingested,
  // withheld or unattested during any await (or before the final publish) makes it stale.
  const attested = new Map<string, number>();
  const isCurrent = () => {
    if (!deviceCurrent()) return false;
    for (const [modelId, revision] of attested) if (tap.drawnShardRevision(modelId) !== revision || !tap.holdsDrawnShards(modelId)) return false;
    const live = getViewerState(), now = viewerSource(live);
    if (!level.current(live)) return false;
    if (now.length !== source.length || !now.every((value, i) => value === source[i]) || !sameMembers(currentSceneGeometry(), drawnAt)) return false;
    return [...live.models].every(([id, model]) => sameMembers(model.geometryResult?.meshes, membersAt.get(id)));
  };
  // Captured once for every replayed and restaged piece; the offset Maps may be mutated in place, so the
  // fence compares the recomputed lift entry by entry, never their identity.
  const level = captureLevelLift(state), lift = level.lift;
  const statuses = new Map(tap.status().map((row) => [row.modelId, row]));
  for (const modelId of state.models.keys()) {
    if (statuses.get(modelId)?.instancedLost) {
      console.warn(`[GeometryBacking] ${modelId}: instancing is lost; a released device recovery would draw stale occurrences`);
      return false;
    }
  }
  // An UNRECORDED drawn list would rebuild an empty scene and call it whole: fail closed. A recorded
  // empty list (every flat type hidden, instancing only) is a real answer and recovers.
  const drawn = drawnAt;
  if (drawn === undefined && [...state.models.values()].some((model) => model.visible !== false && (model.geometryResult?.meshes.length ?? 0) > 0)) {
    console.warn('[GeometryBacking] no drawn list was recorded for a scene with flat geometry; refusing a released device recovery');
    return false;
  }
  const { replayReleasedGeometry } = await import('@ifc-lite/renderer');
  const flat = await releasedBatches((drawn ?? []).slice()); // the captured membership, never the live list
  async function* placed(): AsyncGenerator<MeshData[]> {
    for await (const batch of flat) yield placeNewMeshesAtCurrentLevel(batch, lift);
  }
  const replayed = await replayReleasedGeometry({ getScene: () => scene, getGPUDevice: () => (isCurrent() ? device : null),
    getPipeline: () => pipeline, requestRender }, placed(), { isCurrent });
  if (replayed.status !== 'complete') return false;
  const indices = modelIndices(state.models);
  for (const modelId of state.models.keys()) {
    const source = tap.replaySource(modelId);
    const modelIndex = indices.get(modelId);
    // Exactly the templates the scene held before the loss: a hidden or removed model stays out.
    if (!hasInstancedShards(modelId) || modelIndex === undefined || !instancedModelIndices.has(modelIndex)) continue;
    // The scene drew this model's instances: only its own complete backing can put them back.
    // And exactly the set it drew: a shard ingested after the seal (a pending successor), one
    // withheld since, or one still queued means the acknowledged copy is not that set.
    if (!source?.backing?.isCurrent || !source.backing.isComplete || !tap.holdsDrawnShards(modelId)) return false;
    attested.set(modelId, tap.drawnShardRevision(modelId));
    for await (const shard of source.backing.reader.instancedShards()) {
      if (!isCurrent()) return false;
      scene.addInstancedShard(device, liftedCopy(shard, lift), modelIndex);
    }
  }
  requestRender();
  return isCurrent();
};
