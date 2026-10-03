/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The viewer records the canonical native layout edit as one undo operation (#6232 D5). */
import { syncRoomLayoutInStore, roomChainInStore, type LayoutSync } from '../../../../../packages/create/src/in-store/room-store.js';
import { modelEditTarget, recordModellingEdit, type ModellingStore } from '@/store/slices/mutation-modelling-records';
import type { LayoutFace } from './room-layout';
import type { RoomCandidate } from './storey-rooms';
import { registerRooms } from './room-writes';
export type { LayoutSync } from '../../../../../packages/create/src/in-store/room-store.js';

export function syncLayoutEdit(store: ModellingStore, modelId: string, before: readonly RoomCandidate[], after: readonly LayoutFace[], storeyId: number): LayoutSync {
  const target = modelEditTarget(store.getState(), modelId);
  if (!target) throw new Error('No editable model');
  const scopes = [...store.getState().models.values()].flatMap(model => {
    const view = store.getState().mutationViews.get(model.id), dataStore = model.ifcDataStore;
    if (!dataStore) return [];
    return [{ dataStore, view: view ?? null }];
  });
  const result = recordModellingEdit(store, modelId, (_methods, draft) => syncRoomLayoutInStore(target.dataStore, draft, before, after, scopes, storeyId));
  for (const id of result.created) {
    const room = roomChainInStore(target.dataStore, target.editor, id);
    if (room.ok) registerRooms(store, modelId, room.storeyId, [id]);
  }
  return result;
}
