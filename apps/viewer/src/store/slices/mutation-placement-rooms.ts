/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Mutation } from '@ifc-lite/mutations';
import { iterateEffectiveEntities } from '@ifc-lite/data';
import { prepareGeneratedRoomUpdate } from '../../../../../packages/create/src/in-store/generated-room-update.js';
import { readAttributes } from '../../../../../packages/create/src/in-store/edit/placement-core.js';
import { GENERATED_SPACE_OBJECTTYPE } from '../../../../../packages/create/src/in-store/generate-spaces.js';
import { effectiveStoreyId } from '@/lib/effective-storey';
import { remeshAfterCommit } from '@/lib/remesh/remesh-registry';
import { modelEditTarget, recordModellingCommit, type ModellingStore } from './mutation-modelling-records';
import { newMutationBatchId } from './mutation-batch-tags';

/** Inspector and gizmo placement edits share the move command's room updater.
 * Read dependencies before changing the placement, then publish both together. */
export function moveWithGeneratedRooms(
  store: ModellingStore, modelId: string, expressId: number,
  pointId: number, coordinates: [number, number, number], continuingBatch?: string,
): Mutation | null {
  const target = modelEditTarget(store.getState(), modelId);
  if (!target || !/^IFC(WALL|WALLSTANDARDCASE|CURTAINWALL)$/.test(target.editor.getEntityType(expressId)?.toUpperCase() ?? '')) return null;
  if (![...iterateEffectiveEntities(target.dataStore, target.view, ['IFCSPACE'])].some(({ expressId: id }) =>
    readAttributes(target.dataStore, target.view, target.editor, id)?.[4] === GENERATED_SPACE_OBJECTTYPE)) return null;
  const storeyId = effectiveStoreyId(target.dataStore, target.view, expressId);
  if (storeyId === undefined) return null;
  const batch = continuingBatch ?? newMutationBatchId();
  const cursor = target.view.getMutationCount();
  const rooms = recordModellingCommit(store, modelId, editor => editor.runAtomic(draft => {
    const update = prepareGeneratedRoomUpdate(target.dataStore, draft, [storeyId]);
    draft.setPositionalAttribute(pointId, 0, coordinates);
    return update();
  }), batch);
  const mutation = target.view.getMutations(cursor).find(m => m.entityId === pointId && m.type === 'UPDATE_POSITIONAL_ATTRIBUTE');
  if (!mutation) throw new Error('Placement edit did not record its coordinate mutation');
  if (rooms.length) remeshAfterCommit(store.getState, modelId, batch, rooms, 'shape');
  return mutation;
}
