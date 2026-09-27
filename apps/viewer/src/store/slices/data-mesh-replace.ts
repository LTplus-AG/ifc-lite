/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `replaceEntityMeshes`: swap the meshes of a few entities for freshly
 * re-meshed ones, in ONE store update (#6232 WP1).
 *
 * Composed from the two existing store-side primitives, so a replacement
 * obeys every rule they already carry:
 *
 *  - `pruneMeshesFromGeometry` drops the entities' current meshes (only the
 *    ones that host no OTHER entity, `hostsOtherEntities`), their slots in
 *    the model's `preAlignment` snapshot, their instanced-only metadata, and
 *    their rotation baselines;
 *  - `appendGeometryBatchPatch` appends the new meshes to the model that owns
 *    them and grows `preAlignment` in lockstep, exactly as a streamed batch.
 *
 * On a federation-aligned model the appended meshes are already in the
 * aligned frame, so the snapshot slots grown for them are then corrected to
 * the pre-alignment copies the caller passes (`correctPreAlignmentTail`, the
 * same fix-up `restoreStashedEntityMesh` applies).
 *
 * The ids are queued on `pendingMeshEdits` with the tick this update ends on,
 * so `useMeshEditDrain` can swap the renderer's copies and knows whether any
 * other geometry change landed in the same render.
 */

import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { FederatedModel } from '../types.js';
import { appendGeometryBatchPatch } from './dataSlice.appendGeometryBatch.js';
import { pruneMeshesFromGeometry } from './data-mesh-prune.js';
import { correctPreAlignmentTail, type PreAlignmentMeshBaseline } from './data-mesh-prealign.js';

/** Entities whose renderer meshes must be swapped for the store's, and the tick of that swap. */
export interface PendingMeshEdits {
  ids: ReadonlySet<number>;
  tick: number;
}

export interface ReplaceMeshesState {
  activeModelId: string | null;
  models: Map<string, FederatedModel>;
  geometryResult: GeometryResult | null;
  geometryUpdateTick: number;
  pendingMeshEdits: PendingMeshEdits | null;
}

/**
 * `replacements` maps GLOBAL ids to their new meshes, already in the render
 * frame; an empty list removes the entity's meshes. `preAligned`, for an
 * aligned model, holds each new mesh's pre-alignment copy in the same order.
 */
export function replaceEntityMeshesPatch(
  state: ReplaceMeshesState,
  modelId: string,
  replacements: ReadonlyMap<number, readonly MeshData[]>,
  preAligned?: ReadonlyMap<number, readonly PreAlignmentMeshBaseline[]>,
): Partial<ReplaceMeshesState> {
  if (replacements.size === 0 || !state.models.has(modelId)) return {};
  const ids = new Set(replacements.keys());
  const pruned = pruneMeshesFromGeometry(state, ids);
  const afterPrune: ReplaceMeshesState = { ...state, ...pruned };

  const appended: MeshData[] = [];
  const baselines: (PreAlignmentMeshBaseline | undefined)[] = [];
  for (const [id, meshes] of replacements) {
    const known = preAligned?.get(id);
    meshes.forEach((mesh, i) => {
      appended.push(mesh);
      baselines.push(known?.[i]);
    });
  }
  const patch = appended.length > 0 ? appendGeometryBatchPatch(afterPrune, modelId, appended) : {};
  let models = patch.models ?? afterPrune.models;
  const model = models.get(modelId);
  if (model?.preAlignment && preAligned && appended.length > 0) {
    models = new Map(models);
    models.set(modelId, { ...model, preAlignment: correctPreAlignmentTail(model.preAlignment, appended.length, baselines) });
  }

  const tick = patch.geometryUpdateTick ?? afterPrune.geometryUpdateTick + 1;
  const geometryResult = patch.geometryResult ?? pruned.geometryResult;
  const pendingIds = new Set(state.pendingMeshEdits?.ids ?? []);
  for (const id of ids) pendingIds.add(id);
  return {
    models,
    ...(geometryResult ? { geometryResult } : {}),
    geometryUpdateTick: tick,
    pendingMeshEdits: { ids: pendingIds, tick },
  };
}
