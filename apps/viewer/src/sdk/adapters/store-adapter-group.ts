/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createGroupStoreBackend, resolveLiveOwnerHistoryId, type CostStoreModelResolver } from '@ifc-lite/sdk';
import { recordResolvedModellingCommit } from '@/store/slices/mutation-modelling-records';
import { mutationDenial } from '@/store/mutation-permission';
import type { StoreApi } from './types.js';

/** Native graph edits share one history batch and the existing room publisher. */
export function createTrackedGroupBackend(store: StoreApi, resolve: CostStoreModelResolver): ReturnType<typeof createGroupStoreBackend> {
  const reads = createGroupStoreBackend(resolve);
  function edit<T>(modelId: string, operation: (methods: ReturnType<typeof createGroupStoreBackend>) => T): T {
    const denial = mutationDenial(store.getState(), modelId);
    if (denial) throw new Error(`bim.store Group: ${denial}`);
    const setState = store.setState;
    if (!setState) throw new Error('bim.store Group requires a writable store');
    const current = resolve(modelId);
    if (current.modelId !== modelId) throw new Error('Group source ownership changed');
    return recordResolvedModellingCommit({ ...store, setState }, {
      modelId, dataStore: current.store, editor: current.editor, view: current.mutationView,
    }, (editor, dataStore) => operation(createGroupStoreBackend(requested => {
      if (requested !== modelId) throw new Error('Group cannot edit another source in this transaction');
      return { modelId, store: dataStore, editor, mutationView: editor.getMutationView(),
        ownerHistoryId: resolveLiveOwnerHistoryId(dataStore, editor, editor.getMutationView()) };
    })));
  }
  return {
    readGroup: reads.readGroup,
    addGroup: (modelId, params) => edit(modelId, methods => methods.addGroup(modelId, params)),
    updateGroup: (expected, patch) => edit(expected.modelId, methods => methods.updateGroup(expected, patch)),
    removeGroup: expected => edit(expected.modelId, methods => methods.removeGroup(expected)),
  };
}
