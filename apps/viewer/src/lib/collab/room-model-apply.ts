/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Write reconstructed room data into the *room's* model — never another one.
 *
 * The recipient side of `startCollab` re-derives the shared model from the CRDT
 * on every peer edit and pushes the result into the store. It used to do that
 * through `setIfcDataStore` / `setGeometryResult`, which target
 * `activeModelId` — an implicit assumption that the room model is the active
 * one. That assumption does not hold: a recipient can have their own file
 * loaded (`?room=…&model=…`, or a file opened while the room is still
 * syncing), and a recipient who joined normally can load a second model and
 * select it in the hierarchy. In either case the next peer edit wrote the
 * room's store and meshes over the user's own model, destroying their
 * geometry.
 *
 * The fix is to address the room model by id. When it *is* active we keep
 * going through the active-model setters (they also refresh the top-level
 * `ifcDataStore` the outbound mutation mirror reads and bump the renderer's
 * geometry tick); when it is not, `updateModel` patches the room model's record
 * in place and leaves the user's active model alone.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult } from '@ifc-lite/geometry';

/** The slice actions this helper needs (a narrow view of the viewer store). */
export interface RoomModelApplyState {
  activeModelId: string | null;
  updateModel: (
    modelId: string,
    patch: { ifcDataStore?: IfcDataStore; geometryResult?: GeometryResult | null },
  ) => void;
  setIfcDataStore: (store: IfcDataStore | null) => void;
  setGeometryResult: (result: GeometryResult | null) => void;
  /** Signal that mesh positions/normals were mutated in place (dataSlice.ts) — see
   *  the call below for why the non-active-model branch needs it too. */
  bumpGeometryContentVersion: () => void;
}

/**
 * Apply reconstructed room data to the room's model.
 *
 * @param state    current store snapshot (actions are read off it)
 * @param roomModelId  id of the reconstructed room model (`room:<roomId>`)
 * @param patch    the fields to write; omitted fields are left untouched
 */
export function applyRoomModelData(
  state: RoomModelApplyState,
  roomModelId: string,
  patch: { ifcDataStore?: IfcDataStore; geometryResult?: GeometryResult | null },
): void {
  const isActive = state.activeModelId === roomModelId;
  if (patch.ifcDataStore !== undefined) {
    if (isActive) state.setIfcDataStore(patch.ifcDataStore);
    else state.updateModel(roomModelId, { ifcDataStore: patch.ifcDataStore });
  }
  if (patch.geometryResult !== undefined) {
    if (isActive) {
      state.setGeometryResult(patch.geometryResult);
    } else {
      state.updateModel(roomModelId, { geometryResult: patch.geometryResult });
      // ViewportContainer's merged-geometry cache is keyed on mesh COUNT per
      // model; it appends only the meshes past the previously seen count and
      // otherwise trusts the cached copies of earlier ones unchanged. A
      // reconstruct commonly re-derives the SAME entity count with DIFFERENT
      // content (a peer's placement/geometry edit), which the count-based
      // trigger can't see — exactly the "in-place mutation" case
      // `geometryContentVersion` exists for (dataSlice.ts). Without this, a
      // recipient viewing a DIFFERENT active model keeps stale (pre-edit)
      // room-model geometry in the merged render buffer.
      state.bumpGeometryContentVersion();
    }
  }
}
