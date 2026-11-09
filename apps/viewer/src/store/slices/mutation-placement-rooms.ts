/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Mutation, StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { iterateEffectiveEntities } from '@ifc-lite/data';
import { prepareGeneratedRoomUpdate } from '../../../../../packages/create/src/in-store/generated-room-update.js';
import { readAttributes } from '../../../../../packages/create/src/in-store/edit/placement-core.js';
import { GENERATED_SPACE_OBJECTTYPE } from '../../../../../packages/create/src/in-store/generate-spaces.js';
import { resolveRotationState, rotateProductYaw } from '@/lib/placement-edit';
import { effectiveStoreyId } from '@/lib/effective-storey';
import { remeshAfterCommit } from '@/lib/remesh/remesh-registry';
import { modelEditTarget, recordModellingCommit, type ModellingStore } from './mutation-modelling-records';
import { newMutationBatchId } from './mutation-batch-tags';

/** Read room dependencies before a placement edit, then publish both together. */
function withGeneratedRooms<T>(
  store: ModellingStore, modelId: string, expressId: number,
  edit: (editor: StoreEditor, data: IfcDataStore) => T,
  continuingBatch?: string, remeshProduct = false,
): { result: T; mutation: Mutation | null; batch: string } | null {
  const target = modelEditTarget(store.getState(), modelId);
  if (!target || !/^IFC(WALL|WALLSTANDARDCASE|CURTAINWALL)$/.test(target.editor.getEntityType(expressId)?.toUpperCase() ?? '')) return null;
  if (![...iterateEffectiveEntities(target.dataStore, target.view, ['IFCSPACE'])].some(({ expressId: id }) =>
    readAttributes(target.dataStore, target.view, target.editor, id)?.[4] === GENERATED_SPACE_OBJECTTYPE)) return null;
  const storeyId = effectiveStoreyId(target.dataStore, target.view, expressId);
  if (storeyId === undefined) return null;
  const batch = continuingBatch ?? newMutationBatchId();
  const committed = recordModellingCommit(store, modelId, editor => editor.runAtomic(draft => {
    const update = prepareGeneratedRoomUpdate(target.dataStore, draft, [storeyId]);
    const view = draft.getMutationView(), cursor = view.getMutationCount();
    const result = edit(draft, target.dataStore);
    // Capture the placement write before room regeneration appends its writes.
    const mutation = view.getMutations(cursor).at(-1) ?? null;
    return { result, mutation, rooms: mutation ? update() : [] };
  }), batch);
  if (committed.rooms.length) remeshAfterCommit(store.getState, modelId, batch,
    remeshProduct ? [expressId, ...committed.rooms] : committed.rooms, remeshProduct ? 'hostsChanged' : 'shape');
  return { result: committed.result, mutation: committed.mutation, batch };
}

/** Inspector and gizmo translations share the move command's room updater. */
export function moveWithGeneratedRooms(
  store: ModellingStore, modelId: string, expressId: number,
  pointId: number, coordinates: [number, number, number], continuingBatch?: string,
): Mutation | null {
  return withGeneratedRooms(store, modelId, expressId,
    editor => editor.getMutationView().setPositionalAttribute(pointId, 0, coordinates), continuingBatch)?.result ?? null;
}

/** Explicit and implicit RefDirection rotations use the same room/history path. */
export function rotateWithGeneratedRooms(store: ModellingStore, modelId: string, expressId: number, angle: number) {
  const target = modelEditTarget(store.getState(), modelId);
  // An unresolved STEP placement still belongs to the existing collab path.
  if (!target || !resolveRotationState(target.dataStore, target.view, target.editor, expressId)) return null;
  return withGeneratedRooms(store, modelId, expressId,
    (editor, data) => rotateProductYaw(data, editor.getMutationView(), editor, expressId, angle), undefined, true);
}
