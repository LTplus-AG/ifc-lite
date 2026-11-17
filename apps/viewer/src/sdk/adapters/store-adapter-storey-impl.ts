/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.store` storey methods in the viewer (#9013): the same write path the
 * storey manager uses (`commitStoreyOp`), so a script's storey edit is one
 * undo step, re-meshes what it moved, and is refused by the same plan.
 *
 * Loaded on its own (`store-adapter-storey.ts`), so the storey planner is
 * not part of the viewer's boot bundle.
 */

import { planStoreyDelete, planStoreyLevelEdit, readStoreyInventory, suggestStorey, summarizeStoreys } from '@ifc-lite/create';
import type { createModellingStoreBackend, EntityRef } from '@ifc-lite/sdk';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { commitStoreyOp, type StoreyOp } from '@/store/slices/mutation-storey';
import { deleteStorey } from '@/lib/storeys/storey-actions';
import type { StoreApi } from './types.js';
import { normalizeMutationModelId } from './mutation-view.js';

type Methods = ReturnType<typeof createModellingStoreBackend>;

export type StoreyMethods = Required<Pick<Methods,
  'listStoreyLevels' | 'suggestStorey' | 'addStorey' | 'renameStorey' | 'planStoreyEdit' | 'editStorey' | 'planStoreyDelete' | 'deleteStorey'>>;

export function storeyMethods(store: StoreApi): StoreyMethods {
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
    // A model with no editable data is a failed read, not an empty model.
    listStoreyLevels: (modelId) => summarizeStoreys(inventory(modelId)),
    suggestStorey: (modelId, referenceStoreyId, side) => suggestStorey(inventory(modelId), referenceStoreyId, side, (index) => `Level ${index}`),
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
    editStorey(modelId, edit, expected) {
      const { normalized, outcome } = commit('editStorey', modelId, { kind: 'level', edit, expected });
      return refs(normalized, [edit.storeyId, ...outcome.remeshed]);
    },
    planStoreyDelete: (ref, mode) => planStoreyDelete(inventory(ref.modelId), ref.expressId, mode),
    deleteStorey(ref, mode, expected) {
      // The manager's own delete: the session leaves the storey first and Solo isolation moves on.
      const normalized = normalizeMutationModelId(store.getState(), ref.modelId);
      const setState = store.setState;
      if (!setState) throw new Error('bim.store.deleteStorey: the adapter requires a writable store');
      const outcome = deleteStorey({ ...store, setState }, normalized, ref.expressId, mode, expected);
      if (!outcome.ok) throw new Error(`bim.store.deleteStorey: ${outcome.reason}`);
      return refs(normalized, [ref.expressId]);
    },
  };
}
