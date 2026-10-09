/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createRoomCommandBackend, type createModellingStoreBackend, type PreparedRoomCommand, type RoomCommand } from '@ifc-lite/sdk';
import { SpacePlateHandle } from '@ifc-lite/wasm';
import type { StoreApi } from './types.js';
import { normalizeMutationModelId } from './mutation-view.js';
import { trackBackendWrite } from './backend-write-capture.js';
import { completePhysicalEdit } from './store-adapter-physical.js';
import { recordModellingCommit } from '@/store/slices/mutation-modelling-records';
import { completeEntityRemoval } from '@/store/slices/mutation-mesh-stash';
import { mutationDenial } from '@/store/mutation-permission';
import { ensureSpaceWasm } from '@/lib/rooms/space-wasm';
import { roomLayoutCache, undoHead } from '@/lib/rooms/room-layout';
import { storeyWalls, storeySpaces, storeyOccupancy, storeyRoomGeometryIds } from '@/lib/rooms/storey-rooms';
import { buildStoreyWorkplane } from '@/lib/commands/modeling/workplane';
import { requestRemesh } from '@/lib/remesh/remesh-service';
import { roomGeometryLease } from './store-adapter-room-geometry';
import { nativeLengthUnitAvailable, readOnlyModelEditTarget } from '@/lib/actions/model-authoring-read-target';

type Methods = ReturnType<typeof createModellingStoreBackend>;

const services = new WeakMap<StoreApi, ReturnType<typeof createNativeRoomService>>();

/** One preparation owner shared by native SDK actions and reviewed actions on this host. */
function nativeRoomService(store: StoreApi) {
  let service = services.get(store);
  if (!service) { service = createNativeRoomService(store); services.set(store, service); }
  return service;
}

function createNativeRoomService(store: StoreApi) {
  type NativeTarget = NonNullable<ReturnType<typeof readOnlyModelEditTarget>>;
  const absentViews = new WeakMap<NativeTarget['dataStore'], Map<string, NativeTarget>>();
  const resolve = (modelId: string) => {
    const denial = mutationDenial(store.getState(), modelId);
    if (denial) throw new Error(denial);
    const state = store.getState();
    const live = state.mutationViews.get(modelId);
    const source = state.models.get(modelId)?.ifcDataStore;
    let target = source ? absentViews.get(source)?.get(modelId) : undefined;
    if (live || !target || target.dataStore !== state.models.get(modelId)?.ifcDataStore) {
      target = readOnlyModelEditTarget(state,modelId) ?? undefined;
      if (target && !live) {
        let targets = absentViews.get(target.dataStore);
        if (!targets) { targets = new Map(); absentViews.set(target.dataStore,targets); }
        targets.set(modelId,target);
      }
    }
    if (!target || !nativeLengthUnitAvailable(target)) throw new Error('Room requires an editable loaded model with an authoritative native length unit');
    return { modelId, store: target.dataStore, editor: target.editor, mutationView: live ?? target.view, ownerHistoryId: null };
  };
  const service = createRoomCommandBackend(resolve, async (model, storeyId) => {
    await ensureSpaceWasm();
    // Await the canonical native mesh producer so an immediately preceding
    // script edit cannot derive rooms from an older renderer snapshot.
    const initial = store.getState(), initialPlane = buildStoreyWorkplane(initial, model.modelId, storeyId, 0);
    if ('refused' in initialPlane) return { walls:[],factory:SpacePlateHandle,unavailable:initialPlane.refused };
    if (!initial.models.get(model.modelId)?.geometryResult) return {walls:[],factory:SpacePlateHandle,unavailable:'Current native mesh geometry is unavailable'};
    const frameBefore = JSON.stringify([[0,0,0],[1,0,0],[0,1,0],[0,0,1]].map(point=>initialPlane.localToRender(point as [number,number,number])));
    const ids = storeyRoomGeometryIds(initial, model.modelId, storeyId, initialPlane);
    if (ids.length) {
      const mesh = await requestRemesh(store.getState, model.modelId, ids, 'shape');
      if (mesh.status !== 'applied') throw new Error(`Room native geometry preparation ${mesh.status}; retry after the model finishes updating`);
    }
    const state = store.getState(), plane = buildStoreyWorkplane(state, model.modelId, storeyId, 0);
    if ('refused' in plane) return {walls:[],factory:SpacePlateHandle,unavailable:plane.refused};
    if (JSON.stringify([[0,0,0],[1,0,0],[0,1,0],[0,0,1]].map(point=>plane.localToRender(point as [number,number,number])))!==frameBefore) throw new Error('The native storey/model frame changed during Room preparation');
    return { factory: SpacePlateHandle, validate:roomGeometryLease(store.getState,model.modelId,storeyId), walls: storeyWalls(state, model.modelId, storeyId, plane),
      spaces: storeySpaces(state, model.modelId, storeyId), occupied: storeyOccupancy(state, model.modelId, storeyId, plane) };
  }, {
    layouts: roomLayoutCache,
    historyHead: modelId => undoHead(store.getState(), modelId),
    globalIdScopes: () => [...store.getState().models].flatMap(([id, model]) => model.ifcDataStore ? [{ dataStore: model.ifcDataStore, view: store.getState().mutationViews.get(id) ?? null }] : []),
    record: (modelId, write) => {
      resolve(modelId);
      const setState = store.setState;
      if (!setState) throw new Error('Room editing requires a writable viewer store');
      return trackBackendWrite(store, () => recordModellingCommit({ ...store, setState }, modelId, (editor, dataStore) =>
        write({ modelId, store: dataStore, editor, mutationView: editor.getMutationView(), ownerHistoryId: null })));
    },
  });
  const prepare = async (modelId: string, storeyId: number, command: RoomCommand): Promise<PreparedRoomCommand> => {
    const normalized = normalizeMutationModelId(store.getState(), modelId);
    const prepared = await service.prepareRoomCommand(normalized, storeyId, command);
    return { ...prepared, commit: () => {
      const undoBefore = store.getState().undoStacks.get(normalized)?.length ?? 0;
      const result = prepared.commit();
      if (result.created.length || result.updated.length || result.deleted.length) {
        const setState = store.setState;
        if (!setState) throw new Error('Room editing requires a writable viewer store');
        for (const ref of result.deleted) completeEntityRemoval(store.getState, setState, normalized, ref.expressId, store.getState().removedNewEntities.get(`${normalized}:${ref.expressId}`));
        completePhysicalEdit(store, normalized, undoBefore, [...result.created, ...result.updated].map(ref => ref.expressId));
      }
      return result;
    } };
  };
  return { prepare,
    async roomCommand(modelId: string, storeyId: number, command: RoomCommand) {
      const prepared = await prepare(modelId, storeyId, command);
      try { return prepared.commit(); } finally { prepared.dispose(); }
    },
  };
}

/** Same native planner, detached graph preview and synchronous approval seam as SDK Room. */
export function prepareNativeRoomCommand(store: StoreApi, modelId: string, storeyId: number, command: RoomCommand): Promise<PreparedRoomCommand> {
  return nativeRoomService(store).prepare(modelId, storeyId, command);
}

/** Native SDK methods keep their existing asynchronous execute-on-call contract. */
export function roomMutationTracking(store: StoreApi): Pick<Methods, 'roomCommand'> {
  return { roomCommand: nativeRoomService(store).roomCommand };
}
