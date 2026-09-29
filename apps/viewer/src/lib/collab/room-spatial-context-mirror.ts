/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreApi } from 'zustand';
import type { CollabSession } from '@ifc-lite/collab';
import type { ViewerState } from '@/store';
import { canMutate } from '@/store/mutation-permission';
import { roomSlotFor, roomStoreFor } from './room-model-target';
import { createRoomSpatialContext, decodeRoomSpatialContext, restoreRoomSpatialFacts } from './room-spatial-context';
import { applyRoomModelData } from './room-model-apply';
import { invalidateHistoryPatch } from '@/store/slices/mutation-redo-remote-guard';
import { isGeorefMutation } from '@/store/slices/mutation-history-prune';

/** #6499: edit, undo and redo all publish through the same slot metadata. */
export function attachRoomSpatialContextMirror(api: StoreApi<ViewerState>, session: CollabSession): () => void {
  const models = session.doc.getMap<unknown>('models');
  let applying = false, publishing = false;
  const notice = (error: unknown) => api.setState({ collabGeometryNotice: error instanceof Error ? error.message : String(error) });
  const receive: Parameters<typeof models.observe>[0] = event => {
    if (publishing || api.getState().collabSession !== session) return;
    applying = true; // Applying remote facts must never echo through the local edit subscription.
    try {
      for (const [modelId, slot] of api.getState().collabRoomModels) {
        if (!event.keysChanged.has(slot.slotId)) continue;
        try {
          const record = models.get(slot.slotId);
          if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
          const decoded = decodeRoomSpatialContext((record as Record<string, unknown>).spatialContext);
          const store = roomStoreFor(api.getState(), modelId);
          if (!decoded || !store) continue;
          const context = structuredClone(decoded);
          restoreRoomSpatialFacts(store, context);
          // Replace the stale local overlay with the received facts. Native
          // owners also retain these fields for the canonical STEP exporter.
          const georefMutations = new Map(api.getState().georefMutations);
          if (context.georeferencing) georefMutations.set(modelId, {
            mapConversion: context.georeferencing.mapConversion,
            projectedCRS: context.georeferencing.projectedCRS,
          });
          else georefMutations.delete(modelId);
          api.setState({ georefMutations, mutationVersion: api.getState().mutationVersion + 1 });
          const current = api.getState();
          api.setState(invalidateHistoryPatch(current.undoStacks, current.redoStacks, current.mutationBatchTags,
            current.mutationMeshTranslations, modelId, isGeorefMutation,
            'A collaborator changed georeferencing. Conflicting local undo and redo history was cleared.'));
          applyRoomModelData(api.getState(), modelId, { ifcDataStore: store });
        } catch (error) { notice(error); }
      }
    }
    finally { applying = false; }
  };
  models.observe(receive);
  const detach = api.subscribe((state, previous) => {
    if (applying || state.collabSession !== session || state.georefMutations === previous.georefMutations) return;
    const ids = new Set([...state.georefMutations.keys(), ...previous.georefMutations.keys()]);
    for (const modelId of ids) {
      if (state.georefMutations.get(modelId) === previous.georefMutations.get(modelId) || !canMutate(state, modelId)) continue;
      const slot = roomSlotFor(state, modelId), store = roomStoreFor(state, modelId);
      if (!slot || !store) continue;
      const record = models.get(slot.slotId);
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
      try {
        const spatialContext = createRoomSpatialContext(store, state.models.get(modelId)?.geometryResult?.coordinateInfo,
          state.georefMutations.get(modelId));
        publishing = true;
        // CollabSession owns LOCAL_ORIGIN, including undo/redo publications.
        session.transact(() => models.set(slot.slotId, { ...record, spatialContext }));
      } catch (error) { notice(error); }
      finally { publishing = false; }
    }
  });
  return () => { detach(); models.unobserve(receive); };
}
