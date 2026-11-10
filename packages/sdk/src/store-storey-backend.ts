/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  addStoreyInStore, applyStoreyDelete, applyStoreyLevelEdit, planStoreyAdd, planStoreyDelete, planStoreyLevelEdit,
  readStoreyInventory, renameStoreyInStore, setTopConstraintInStore, suggestStorey, summarizeStoreys,
} from '@ifc-lite/create';
import type { ModellingStoreModelResolver } from './store-modelling-backend.js';
import type { StoreyStoreBackendMethods } from './store-storey-types.js';
import type { EntityRef } from './types.js';

/** Host bookkeeping stays at the edge; planning and graph writes are the shared create functions. */
export function createStoreyStoreBackend(resolve: ModellingStoreModelResolver): Required<StoreyStoreBackendMethods> {
  const refs = (modelId: string, ids: readonly number[]): EntityRef[] => [...new Set(ids)].map((expressId) => ({ modelId, expressId }));
  const inventory = (modelId: string) => {
    const model = resolve(modelId);
    return { model, inventory: readStoreyInventory(model.store, model.mutationView) };
  };
  return {
    listStoreyLevels(modelId) {
      return summarizeStoreys(inventory(modelId).inventory);
    },
    suggestStorey(modelId, referenceStoreyId, side) {
      // The fallback name is English, like every other SDK default; the viewer localises its own.
      return suggestStorey(inventory(modelId).inventory, referenceStoreyId, side, (index) => `Level ${index}`);
    },
    addStorey(modelId, params) {
      const model = resolve(modelId);
      return { modelId: model.modelId, expressId: addStoreyInStore(model.store, model.editor, params).storeyId };
    },
    planAddStorey(modelId, params) {
      return planStoreyAdd(inventory(modelId).inventory, params);
    },
    setTopConstraint(ref, constraint) {
      const model = resolve(ref.modelId);
      return refs(model.modelId, [ref.expressId, ...setTopConstraintInStore(model.store, model.editor, ref.expressId, constraint).remesh]);
    },
    renameStorey(ref, Name) {
      const model = resolve(ref.modelId);
      renameStoreyInStore(model.store, model.editor, ref.expressId, Name);
      return { modelId: model.modelId, expressId: ref.expressId };
    },
    planStoreyEdit(modelId, edit) {
      return planStoreyLevelEdit(inventory(modelId).inventory, edit);
    },
    editStorey(modelId, edit, expected) {
      const model = resolve(modelId);
      const { plan, reshaped } = applyStoreyLevelEdit(model.store, model.editor, edit, expected);
      return refs(model.modelId, [...plan.storeys.map((storey) => storey.expressId), ...plan.moved, ...reshaped]);
    },
    planStoreyDelete(ref, mode) {
      return planStoreyDelete(inventory(ref.modelId).inventory, ref.expressId, mode);
    },
    deleteStorey(ref, mode, expected) {
      const model = resolve(ref.modelId);
      const plan = applyStoreyDelete(model.store, model.editor, ref.expressId, mode, expected);
      return refs(model.modelId, [ref.expressId, ...(mode.kind === 'deleteContents' ? plan.contents : [])]);
    },
  };
}
