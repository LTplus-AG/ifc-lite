/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createRoomCommandBackend, type ModellingStoreModelResolver } from '@ifc-lite/sdk';
import { RoomLayoutCache } from '@ifc-lite/create';
import { recordCompoundMutation, StoreEditor } from '@ifc-lite/mutations';
import { createCachedHeadlessRoomGeometryProvider } from './headless-room-geometry.js';

/** Native preparation finishes before the synchronous compound commit begins. */
export function createHeadlessRoomBackend(resolve: ModellingStoreModelResolver) {
  const native = createCachedHeadlessRoomGeometryProvider();
  const rooms = createRoomCommandBackend(resolve, native.provide, {
    layouts: new RoomLayoutCache(),
    globalIdScopes: () => resolve().globalIdScopes ?? [],
    historyHead: modelId => resolve(modelId).mutationView.getMutations().map(m => m.id).join('|'),
    record: (modelId, write) => {
      const model = resolve(modelId);
      return recordCompoundMutation(model.mutationView, mutationView => write({
        ...model, mutationView, editor: new StoreEditor(model.store, mutationView),
      }));
    },
  });
  return { ...rooms, disposeRooms() { rooms.disposeRooms(); native.clear(); } };
}
