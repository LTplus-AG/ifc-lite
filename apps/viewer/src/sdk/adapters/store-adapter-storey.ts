/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.store` storey methods in the viewer (#9013): the same write path the
 * storey manager uses (`commitStoreyOp`), so a script's storey edit is one
 * undo step, re-meshes what it moved, and is refused by the same plan.
 */

import { planStoreyDelete, planStoreyLevelEdit, readStoreyInventory } from '@ifc-lite/create';
import type { createModellingStoreBackend, EntityRef } from '@ifc-lite/sdk';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { commitStoreyOp, type StoreyOp } from '@/store/slices/mutation-storey';
import { storeyRows } from '@/lib/storeys/storey-actions';
import type { StoreApi } from './types.js';
import { normalizeMutationModelId } from './mutation-view.js';

type Methods = ReturnType<typeof createModellingStoreBackend>;

export function storeyMutationTracking(store: StoreApi): Pick<Methods,
  'listStoreyLevels' | 'addStorey' | 'renameStorey' | 'planStoreyEdit' | 'editStorey' | 'planStoreyDelete' | 'deleteStorey'> {
  const inventory = (modelId: string) => {
    const normalized = normalizeMutationModelId(store.getState(), modelId);
    const target = modelEditTarget(store.getState(), normalized);
    if (!target) throw new Error(`No model loaded for id "${modelId}"`);
    return readStoreyInventory(target.dataStore, target.view);
  };
  const commit = (op: string, modelId: string, storeyOp: StoreyOp) => {
    const normalized = normalizeMutationModelId(store.getState(), modelId);
    const setState = store.setState;
    if (!setState) throw new Error(`bim.store.${op}: the adapter requires a writable store`);
    const outcome = commitStoreyOp({ ...store, setState }, normalized, storeyOp);
    if (!outcome.ok) throw new Error(`bim.store.${op}: ${outcome.reason}`);
    return { normalized, outcome };
  };
  const refs = (modelId: string, ids: readonly number[]): EntityRef[] => [...new Set(ids)].map((expressId) => ({ modelId, expressId }));
  return {
    listStoreyLevels: (modelId) => storeyRows(store.getState(), normalizeMutationModelId(store.getState(), modelId)),
    addStorey(modelId, params) {
      const { normalized, outcome } = commit('addStorey', modelId, { kind: 'add', params });
      if (outcome.storeyId === null) throw new Error('bim.store.addStorey: the storey was not written');
      return { modelId: normalized, expressId: outcome.storeyId };
    },
    renameStorey(ref, Name) {
      const { normalized } = commit('renameStorey', ref.modelId, { kind: 'rename', storeyId: ref.expressId, Name });
      return { modelId: normalized, expressId: ref.expressId };
    },
    planStoreyEdit: (modelId, edit) => planStoreyLevelEdit(inventory(modelId), edit),
    editStorey(modelId, edit) {
      const { normalized, outcome } = commit('editStorey', modelId, { kind: 'level', edit });
      return refs(normalized, [edit.storeyId, ...outcome.remeshed]);
    },
    planStoreyDelete: (ref, mode) => planStoreyDelete(inventory(ref.modelId), ref.expressId, mode),
    deleteStorey(ref, mode) {
      const { normalized } = commit('deleteStorey', ref.modelId, { kind: 'delete', storeyId: ref.expressId, mode });
      return refs(normalized, [ref.expressId]);
    },
  };
}
