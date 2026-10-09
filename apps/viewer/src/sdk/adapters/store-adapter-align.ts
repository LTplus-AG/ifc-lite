/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createAlignCommandBackend, type createModellingStoreBackend } from '@ifc-lite/sdk';
import type { StoreApi } from './types.js';
import { normalizeMutationModelId } from './mutation-view.js';
import { trackBackendWrite } from './backend-write-capture.js';
import { completePhysicalEdit } from './store-adapter-physical.js';
import { modelEditTarget, recordModellingCommit } from '@/store/slices/mutation-modelling-records';
import { mutationDenial } from '@/store/mutation-permission';
import { undoHead } from '@/lib/rooms/room-layout';
import { prepareNativeAlignmentGeometry } from '@/lib/element-transform/prepare-alignment';

/** Fresh owning-model geometry, collab gate, one shared history record. */
export function alignMutationTracking(store: StoreApi): Pick<ReturnType<typeof createModellingStoreBackend>, 'alignElements'> {
  const resolve = (modelId: string) => {
    const denial = mutationDenial(store.getState(), modelId);
    if (denial) throw new Error(denial);
    const target = modelEditTarget(store.getState(), modelId);
    if (!target) throw new Error('Align requires an editable loaded model');
    return { modelId, store: target.dataStore, editor: target.editor, mutationView: target.view, ownerHistoryId: null };
  };
  const service = createAlignCommandBackend(resolve, async (model, storeyId, ids) => {
    return (await prepareNativeAlignmentGeometry(store.getState, model.modelId, storeyId, ids)).boxes;
  }, {
    historyHead: modelId => undoHead(store.getState(), modelId),
    record: (modelId, write) => {
      resolve(modelId);
      const setState = store.setState;
      if (!setState) throw new Error('Align editing requires a writable viewer store');
      return trackBackendWrite(store, () => recordModellingCommit({ ...store, setState }, modelId, (editor, dataStore) =>
        write({ modelId, store: dataStore, editor, mutationView: editor.getMutationView(), ownerHistoryId: null })));
    },
  });
  return {
    async alignElements(modelId, reference, targets, mode) {
      const normalized = normalizeMutationModelId(store.getState(), modelId);
      const undoBefore = store.getState().undoStacks.get(normalized)?.length ?? 0;
      const result = await service.alignElements(normalized, reference, targets, mode);
      completePhysicalEdit(store, normalized, undoBefore, result.map(ref => ref.expressId));
      return result;
    },
  };
}
