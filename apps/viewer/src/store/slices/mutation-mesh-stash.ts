/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Store-level mesh stash for the inverse of a `CREATE_ENTITY` / `DELETE_ENTITY`
 * mutation (#4925).
 *
 * `undo`/`redo` in `mutationSlice.ts` route both a split's source removal and
 * an authored entity's creation through the IFC overlay (`view.deleteEntity` /
 * `view.restoreFromTombstone` / `view.restoreNewEntity`). That governs export
 * correctness, but says nothing about the RENDERED mesh: before this file
 * existed, the delete path only flipped `hiddenEntities` visibility, which
 * does nothing once `pruneGeometryMeshes` has actually dropped the mesh out
 * of `geometryResult` (as a split's source removal does) — so undoing a split
 * never brought the source back, and undoing a create never removed the
 * halves.
 *
 * `stashAndPruneEntityMesh` / `restoreStashedEntityMesh` are the shared
 * inverse pair: whichever mutation type is being undone/redone in the
 * "this entity's mesh should disappear" direction calls the former, and
 * "this entity's mesh should come back" calls the latter. Both operate purely
 * on the store (`geometryResult.meshes`, `totalTriangles`/`totalVertices` via
 * `pruneGeometryMeshes`/`appendGeometryBatch`, and the `pendingMeshRemovals`
 * queue that `useGeometryStreaming` drains into the renderer scene) so they
 * work identically in a headless test and in the browser.
 */

import type { ViewerState } from '../index.js';
import { toGlobalIdFromModels } from '../globalId.js';

type Get = () => ViewerState;
type Set = (partial: Partial<ViewerState> | ((s: ViewerState) => Partial<ViewerState>)) => void;

/**
 * Stash the entity's currently-rendered mesh(es) into `removedMeshes`
 * (keyed by `${modelId}:${expressId}`), prune them out of
 * `geometryResult`, and queue the matching renderer-side removal —
 * the store-level half of "delete this entity's geometry".
 *
 * Shared by `removeEntity` (the DELETE_ENTITY mutation) and the
 * `CREATE_ENTITY` undo handler (undoing a create must remove the
 * created mesh, not just tombstone the overlay record) so both
 * "this entity's mesh should disappear" paths share one
 * implementation.
 *
 * No-op (returns false) when the entity has no mesh in the owning
 * model's `geometryResult` right now — nothing to stash or prune.
 */
export function stashAndPruneEntityMesh(
  get: Get,
  set: Set,
  modelId: string,
  expressId: number,
): boolean {
  const state = get();
  const globalId = toGlobalIdFromModels(state.models, modelId, expressId);
  const meshes = (state.models.get(modelId)?.geometryResult?.meshes ?? []).filter(
    (m) => m.expressId === globalId,
  );
  if (meshes.length === 0) return false;

  set((s) => {
    const next = new Map(s.removedMeshes);
    next.set(`${modelId}:${expressId}`, meshes);
    return { removedMeshes: next };
  });
  get().pruneGeometryMeshes(new Set([globalId]));
  get().setPendingMeshRemovals(new Set([globalId]));
  return true;
}

/**
 * Inverse of `stashAndPruneEntityMesh`: pop the stashed mesh(es) for
 * `expressId` (if any) and re-append them via `appendGeometryBatch`,
 * then cancel any still-queued renderer removal for the same global
 * id — without this, an undo/redo that lands between two animation
 * frames could have the pending-removal drain wipe the mesh right
 * back out after this call puts it back.
 *
 * No-op when nothing is stashed (e.g. the entity never had a mesh to
 * begin with).
 */
export function restoreStashedEntityMesh(
  get: Get,
  set: Set,
  modelId: string,
  expressId: number,
): void {
  const key = `${modelId}:${expressId}`;
  const meshes = get().removedMeshes.get(key);
  if (!meshes || meshes.length === 0) return;

  set((s) => {
    const next = new Map(s.removedMeshes);
    next.delete(key);
    return { removedMeshes: next };
  });
  get().appendGeometryBatch(modelId, meshes);

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
