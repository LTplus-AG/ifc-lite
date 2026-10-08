/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Viewer history/tree adapter for the shared Room graph writers (#6232 D5). */
import { createRoomsInStore, updateRoomOutlineInStore, type NewRoom, type RoomUpdate } from '../../../../../packages/create/src/in-store/room-store.js';
import { roomOutline } from '../../../../../packages/create/src/in-store/room-candidates.js';
import type { ViewerState } from '@/store';
import { modelEditTarget, recordModellingEdit, type ModellingStore } from '@/store/slices/mutation-modelling-records';
import { registerAuthoredElement } from '@/utils/spatialHierarchy';
import type { RoomBoundary, RoomCandidate } from './storey-rooms';
export type { NewRoom, RoomUpdate } from '../../../../../packages/create/src/in-store/room-store.js';

/** Register after atomic commit; a refused graph must never leak into the tree. */
export function registerRooms(store: ModellingStore, modelId: string, storeyId: number, ids: readonly number[]): void {
  const target = modelEditTarget(store.getState(), modelId);
  const hierarchy = target?.dataStore.spatialHierarchy;
  if (!hierarchy) return;
  for (const id of ids) {
    const record = target.view.getNewEntity(id);
    if (!record) continue;
    const name = record.attributes[2];
    registerAuthoredElement(hierarchy, storeyId, id, record.type.toUpperCase(), typeof name === 'string' ? name : '');
  }
}

export function addRooms(store: ModellingStore, modelId: string, storeyId: number, rooms: readonly NewRoom[]): number[] {
  const target = modelEditTarget(store.getState(), modelId);
  if (!target) throw new Error('No editable model');
  const ids = recordModellingEdit(store, modelId, (_methods, draft) => createRoomsInStore(target.dataStore, draft, storeyId, rooms));
  registerRooms(store, modelId, storeyId, ids);
  return ids;
}

export function addRoom(store: ModellingStore, modelId: string, storeyId: number, room: NewRoom): number {
  return addRooms(store, modelId, storeyId, [room])[0];
}

export function candidateRoom(room: RoomCandidate, boundary: RoomBoundary): Pick<NewRoom, 'outline' | 'grossArea' | 'netArea'> {
  return { outline: roomOutline(room, boundary), grossArea: room.grossArea, netArea: room.netArea };
}

/** Selected live rooms; federation/overlay ids resolve through the canonical store resolver. */
export function selectedRooms(s: ViewerState, modelId: string): number[] {
  const ids = new Set(s.selectedEntityIds);
  if (s.selectedEntityId !== null) ids.add(s.selectedEntityId);
  const view = s.mutationViews.get(modelId), data = s.models.get(modelId)?.ifcDataStore;
  const out: number[] = [];
  for (const id of ids) {
    const ref = s.resolveGlobalIdFromModels(id);
    if (!ref || ref.modelId !== modelId || view?.isDeleted(ref.expressId)) continue;
    const type = view?.getNewEntity(ref.expressId)?.type ?? data?.entities.getTypeName(ref.expressId);
    if (type?.toUpperCase() === 'IFCSPACE') out.push(ref.expressId);
  }
  return out;
}

export function updateRoomOutline(store: ModellingStore, modelId: string, id: number, boundary: RoomBoundary, roomsOn: (storeyId: number) => readonly RoomCandidate[]): RoomUpdate {
  const target = modelEditTarget(store.getState(), modelId);
  if (!target) throw new Error('No editable model');
  return recordModellingEdit(store, modelId, (_methods, draft) => updateRoomOutlineInStore(target.dataStore, draft, id, boundary, roomsOn));
}
