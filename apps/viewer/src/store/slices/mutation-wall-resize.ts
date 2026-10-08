/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Wall endpoint resize (#6233): the metre-space read, the batched write, and
 * the mesh rebuild that follows a resize and its undo / redo.
 *
 * Units: the viewer authors in metres (raycasts, handles, meshes), while the
 * wall's STEP entities hold the file's native length unit. Every value that
 * crosses this module's boundary is metres; `toNativeLength` /
 * `fromNativeLength` convert at the STEP edge.
 *
 * A wall with joins, cut ends, an offset body or an `Axis` representation is
 * re-shaped by `reshapeWallsIn` (`@ifc-lite/create`): its body and axis are
 * rewritten and every join that touches it is recomputed, so the corners stay
 * clean. A plain rectangle wall with none of those takes the cheap four-slot
 * write below.
 *
 * Mesh: the wall is re-meshed by the wasm mesher from its edited IFC data
 * (`requestRemesh`, #6232), with its openings and the windows and doors in
 * them, which are placed relative to it. Each batch is remembered for undo /
 * redo (`remesh-registry.ts`). A drag re-meshes once, at release
 * (`refreshWallMesh`), not on every frame. Collaborators receive the same
 * re-meshed geometry after the resize and after its undo / redo.
 */

import { mutationDenial } from '../mutation-permission.js';
import type { ViewerState } from '../index.js';
import { rememberRemesh } from '@/lib/remesh/remesh-registry.js';
import { requestRemesh } from '@/lib/remesh/remesh-service.js';
import { newMutationBatchId } from './mutation-batch-tags.js';
import { recordModellingEdit, type ModellingStore } from './mutation-modelling-records.js';
import { resizeWallInStore, type WallEditContext, type WallResizeOptions, type WallResizeOutcome } from '../../../../../packages/create/src/in-store/wall-size-edit.js';
export { readWallMetres, type WallEditContext, type WallResizeOptions, type WallResizeOutcome, type WallMetres } from '../../../../../packages/create/src/in-store/wall-size-edit.js';

type Get = () => ViewerState;
type Vec3 = [number, number, number];

export function resizeWallMetres(
  store: ModellingStore, ctx: WallEditContext, modelId: string, expressId: number,
  newStart: Vec3, newEnd: Vec3, batchId?: string, options: WallResizeOptions = {},
): WallResizeOutcome {
  const denial = mutationDenial(store.getState(), modelId);
  if (denial) return { ok: false, reason: denial };
  const batch = batchId ?? newMutationBatchId();
  try {
    const outcome = recordModellingEdit(store, modelId, (_methods, draft) => {
      const result = resizeWallInStore({ dataStore: ctx.dataStore, view: draft.getMutationView(), editor: draft }, expressId, newStart, newEnd, options);
      if (!result.ok) throw new Error(result.reason);
      return result;
    }, batch);
    rememberRemesh(store.getState, batch, modelId, outcome.walls, 'hostsChanged');
    const cut = outcome.walls.filter((id) => id !== expressId);
    if (batchId === undefined && cut.length > 0) void requestRemesh(store.getState, modelId, cut, 'hostsChanged');
    return outcome;
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Re-mesh the wall (and what it hosts) from its current IFC data, for the view and the room. */
export function refreshWallMeshIn(get: Get, modelId: string, expressId: number): void {
  void requestRemesh(get, modelId, [expressId], 'hostsChanged');
}
