/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, type Mutation } from '@ifc-lite/mutations';
import { configureMutationView } from '@/utils/configureMutationView';
import { roomSymbolicSource } from './room-symbolic-source';

export interface RoomStepExportSource {
  dataStore: IfcDataStore;
  mutationView?: MutablePropertyView;
  toSourceIds(ids: ReadonlySet<number> | null | undefined): Set<number> | null | undefined;
}

/** True only while the portable source covers every root in the live room. */
export function canExportRoomAsStep(
  roomStore: IfcDataStore,
  roomView?: MutablePropertyView,
): boolean {
  const portable = roomSymbolicSource(roomStore);
  if (!portable) return false;
  if (portable.ownerIds.size !== portable.seededIds.size) return false;
  const portableRoomIds = new Set(portable.ownerIds.values());
  if (portableRoomIds.size !== roomStore.entities.expressId.length) return false;
  if (!roomStore.entities.expressId.every(roomId => portableRoomIds.has(roomId))) return false;
  if (!roomView) return true;
  return roomView.getMutations().every(mutation => portableRoomIds.has(mutation.entityId));
}

/**
 * Recover a room slot's complete STEP model for ordinary IFC export. Room
 * mutations address the reconstructed IFCX ids, so replay them under the
 * source ids matched by GlobalId before handing the model to StepExporter.
 */
export function roomStepExportSource(
  roomStore: IfcDataStore,
  roomView: MutablePropertyView | undefined,
  modelId: string,
): RoomStepExportSource | null {
  const portable = roomSymbolicSource(roomStore);
  if (!portable || !canExportRoomAsStep(roomStore, roomView)) return null;

  const sourceIdByRoomId = new Map<number, number>();
  for (const [sourceId, roomId] of portable.ownerIds) sourceIdByRoomId.set(roomId, sourceId);
  const toSourceIds = (ids: ReadonlySet<number> | null | undefined): Set<number> | null | undefined => {
    if (ids === null || ids === undefined) return ids;
    const out = new Set<number>();
    for (const roomId of ids) {
      const sourceId = sourceIdByRoomId.get(roomId);
      if (sourceId === undefined) throw new Error(`Room entity #${roomId} is outside the portable IFC source.`);
      out.add(sourceId);
    }
    return out;
  };
  if (!roomView || roomView.getMutations().length === 0) {
    return { dataStore: portable.dataStore, toSourceIds };
  }
  const mutations: Mutation[] = roomView.getMutations().map(mutation => ({
    ...mutation,
    modelId,
    entityId: sourceIdByRoomId.get(mutation.entityId)!,
  }));
  const view = new MutablePropertyView(portable.dataStore.properties, modelId);
  configureMutationView(view, portable.dataStore);
  view.applyMutations(mutations);
  return { dataStore: portable.dataStore, mutationView: view, toSourceIds };
}
