/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Viewer rotate of an entity whose IfcAxis2Placement3D leaves RefDirection
 * implicit (`$`, #8446), plus the mesh / peer tail every STEP rotate shares.
 *
 * The implicit case creates an IfcDirection seeded with the frame the
 * renderer already draws (`firstProjAxis(Axis)`, or +X with no Axis), links
 * it, and turns it. `rotateProductYaw` does those writes; they run in one
 * atomic draft and land in history as one batch, so a single undo restores
 * the `$` record and drops the new IfcDirection.
 */

import type { Mutation } from '@ifc-lite/mutations';
import type { ViewerState } from '../index.js';
import { getEntityCenter } from '@/utils/viewportUtils';
import { toGlobalIdFromModels } from '../globalId.js';
import { meshesForOwningModel } from '../owningModelMeshes.js';
import { rotateProductYaw } from '@/lib/placement-edit.js';
import { newMutationBatchId } from './mutation-batch-tags.js';
import { remeshGridPlacementAfterCommit } from './mutation-grid-remesh';
import { recordModellingCommit, type ModellingStore } from './mutation-modelling-records.js';

type Get = () => ViewerState;
type RotateOutcome = { ok: true; newYawZ: number } | { ok: false; reason: string };

/** Rotate an entity with an implicit RefDirection as one undo step. */
export function rotateImplicitRefEntity(
  store: ModellingStore, get: Get, modelId: string, expressId: number, deltaYaw: number,
): RotateOutcome {
  const batch = newMutationBatchId();
  const result = recordModellingCommit(store, modelId, (editor, dataStore) =>
    editor.runAtomic((draft) => rotateProductYaw(dataStore, draft.getMutationView(), draft, expressId, deltaYaw)), batch);
  if (!result.ok) return result;
  // The last write is the RefDirection's ratios: the one a grid remesh keys on.
  const mutations = get().mutationViews.get(modelId)?.getMutations() ?? [];
  presentEntityRotation(get, modelId, expressId, deltaYaw, mutations[mutations.length - 1] ?? null, batch);
  return { ok: true, newYawZ: result.newYawZ };
}

/** Re-mesh a grid or live-rotate the mesh, then mirror the turn to peers. */
export function presentEntityRotation(
  get: Get, modelId: string, expressId: number, deltaYaw: number,
  mutation: Mutation | null, continuingBatch?: string,
): void {
  if (!remeshGridPlacementAfterCommit(get, modelId, expressId, mutation, continuingBatch)) {
    // Live-rotate the rendered mesh about its bbox centre (IFC yaw about Z
    // = renderer yaw about +Y, same angle).
    const globalId = toGlobalIdFromModels(get().models, modelId, expressId);
    const c = getEntityCenter(meshesForOwningModel(get(), modelId), globalId);
    if (c) {
      get().setPendingMeshRotations(
        new Map([[globalId, { angle: deltaYaw, pivot: [c.x, c.y, c.z] as [number, number, number] }]]),
      );
    }
  }
  // Mirror to peers as the entity's placement (`usd::xformop` refDirection).
  get().mirrorPlacementEdit(modelId, expressId, [0, 0, 0], deltaYaw);
}
