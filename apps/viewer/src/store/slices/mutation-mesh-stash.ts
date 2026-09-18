/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Store-level mesh stash for the inverse of a `CREATE_ENTITY` / `DELETE_ENTITY`
 * mutation (#4925): delete/undo-of-create must remove a mesh from
 * `geometryResult`, undo-of-delete/redo-of-create must bring it back.
 *
 * Two invariants: only stash meshes `pruneGeometryMeshes` actually removes
 * (`!hostsOtherEntities`, or a colour-merged mesh duplicates), and stash the
 * PRISTINE frame (`modelRotationBaker.inModelFrame`) so a rotated model
 * doesn't get the mesh turned twice on restore.
 */

import { hostsOtherEntities } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import type { ViewerState } from '../index.js';
import { toGlobalIdFromModels } from '../globalId.js';
import { modelRotationBaker } from '../../lib/model-placement/rotation-bake.js';
import { correctPreAlignmentTail, type PreAlignmentMeshBaseline } from './data-mesh-prealign.js';

type Get = () => ViewerState;
type Set = (partial: Partial<ViewerState> | ((s: ViewerState) => Partial<ViewerState>)) => void;

/** What `removedMeshes` holds per stashed entity: the pristine (unrotated)
 *  mesh bytes to re-append, plus — when the model was federation-aligned at
 *  delete time — that mesh's true `preAlignment` baseline (#4970): `inModelFrame`
 *  only reverses the placement-rotation bake, not alignment, so the bytes
 *  above are still in the aligned frame and cannot double as their own
 *  baseline the way a freshly-authored mesh's can. */
export interface RemovedMeshStash {
  meshes: MeshData[];
  preAlignment?: (PreAlignmentMeshBaseline | undefined)[];
}

/**
 * Stash the entity's mesh(es) into `removedMeshes` (keyed by
 * `${modelId}:${expressId}`) and prune them from `geometryResult` — shared
 * by `removeEntity` and `CREATE_ENTITY` undo. Returns false (nothing to
 * prune, e.g. colour-merged or no mesh) so the caller can fall back to
 * hiding instead.
 */
export function stashAndPruneEntityMesh(
  get: Get,
  set: Set,
  modelId: string,
  expressId: number,
): boolean {
  const state = get();
  const globalId = toGlobalIdFromModels(state.models, modelId, expressId);
  const model = state.models.get(modelId);
  const allMeshes = model?.geometryResult?.meshes ?? [];
  // Mirror pruneGeometryMeshes' own removal predicate exactly — stashing a
  // mesh it declines to remove (because other entities still host on it)
  // would duplicate it in geometryResult on restore.
  const removable = allMeshes.filter((m) => m.expressId === globalId && !hostsOtherEntities(m));
  if (removable.length === 0) return false;

  // Stash the PRISTINE (unrotated) frame, not the live vertices: a rotated
  // model's live mesh already has the current heading baked in, and
  // appendGeometryBatch would bake it a second time on restore.
  const pristine = removable.map((m) => modelRotationBaker.inModelFrame(m));

  // #4970: capture each removed mesh's TRUE preAlignment slot before
  // pruneGeometryMeshes's prunePreAlignment drops it below — this is the
  // exact value a later restore needs, not a guess from the (possibly still
  // aligned) pristine bytes above.
  const snap = model?.preAlignment;
  const preAlignment: (PreAlignmentMeshBaseline | undefined)[] | undefined = snap
    ? removable.map((m): PreAlignmentMeshBaseline | undefined => {
      const idx = allMeshes.indexOf(m);
      if (idx < 0 || idx >= snap.positions.length) return undefined;
      const origin = snap.origins[idx];
      return {
        positions: new Float32Array(snap.positions[idx]),
        normals: snap.normals[idx] ? new Float32Array(snap.normals[idx]!) : undefined,
        origin: origin ? [...origin] : undefined,
        geometryAabb: snap.geometryAabbs[idx],
      };
    })
    : undefined;

  set((s) => {
    const next = new Map(s.removedMeshes);
    next.set(`${modelId}:${expressId}`, { meshes: pristine, preAlignment });
    return { removedMeshes: next };
  });
  get().pruneGeometryMeshes(new Set([globalId]));
  get().setPendingMeshRemovals(new Set([globalId]));
  return true;
}

/**
 * Inverse of `stashAndPruneEntityMesh`: pop the stashed mesh(es), if any,
 * re-append them via `appendGeometryBatch`, correct their `preAlignment`
 * slots with the baseline stashed at delete time (#4970 — see
 * `RemovedMeshStash`), then cancel any still-queued `pendingMeshRemovals`
 * entry for the same id so a same-frame drain can't wipe the mesh right
 * back out.
 */
export function restoreStashedEntityMesh(
  get: Get,
  set: Set,
  modelId: string,
  expressId: number,
): void {
  const key = `${modelId}:${expressId}`;
  const stash = get().removedMeshes.get(key);
  if (!stash || stash.meshes.length === 0) return;

  set((s) => {
    const next = new Map(s.removedMeshes);
    next.delete(key);
    return { removedMeshes: next };
  });
  get().appendGeometryBatch(modelId, stash.meshes);
  if (stash.preAlignment) {
    const count = stash.meshes.length;
    const known = stash.preAlignment;
    set((s) => {
      const model = s.models.get(modelId);
      if (!model?.preAlignment) return {};
      const nextModels = new Map(s.models);
      nextModels.set(modelId, {
        ...model,
        preAlignment: correctPreAlignmentTail(model.preAlignment, count, known),
      });
      return { models: nextModels };
    });
  }

  const globalId = toGlobalIdFromModels(get().models, modelId, expressId);
  set((s) => {
    if (!s.pendingMeshRemovals || !s.pendingMeshRemovals.has(globalId)) return {};
    const nextPending = new Set(s.pendingMeshRemovals);
    nextPending.delete(globalId);
    return { pendingMeshRemovals: nextPending.size > 0 ? nextPending : null };
  });
}

/**
 * Drop every `${modelId}:...` key out of a stash map. Shared by
 * `clearMutationView` / `clearMutations` for both `removedNewEntities`
 * and `removedMeshes` so a model's leftover undo payloads don't leak
 * into a future mutation view reusing the same id.
 */
export function pruneStashByModel<T>(map: Map<string, T>, modelId: string): Map<string, T> {
  const next = new Map(map);
  const prefix = `${modelId}:`;
  for (const key of next.keys()) {
    if (key.startsWith(prefix)) next.delete(key);
  }
  return next;
}
