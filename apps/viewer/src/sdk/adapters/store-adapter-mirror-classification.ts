// SPDX-License-Identifier: MPL-2.0
import { expandAffectedSet } from '@ifc-lite/export';
import type { ModellingStoreBackendMethods } from '@ifc-lite/sdk';
import { modelEditTarget, recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { mutationDenial } from '@/store/mutation-permission';
import { completePhysicalEdit } from './store-adapter-physical.js';
import { normalizeMutationModelId } from './mutation-view.js';
import type { StoreApi } from './types.js';

/** Viewer history/room publication over the same storey-free SDK builders. */
export function mirrorClassificationMutationTracking(store: StoreApi): Pick<ModellingStoreBackendMethods,
  'mirrorElements' | 'addClassification' | 'assignClassification'> {
  const target = (modelId: string) => {
    const normalized = normalizeMutationModelId(store.getState(), modelId);
    const denial = mutationDenial(store.getState(), normalized);
    if (denial) throw new Error(denial);
    const setState = store.setState;
    if (!setState) throw new Error('Modelling requires a writable viewer store');
    return { normalized, writable: { ...store, setState } };
  };
  return {
    mirrorElements(modelId, ids, params) {
      const { normalized, writable } = target(modelId);
      const undoBefore = store.getState().undoStacks.get(normalized)?.length ?? 0;
      const result = recordModellingEdit(writable, normalized, methods => {
        if (!methods.mirrorElements) throw new Error('Missing mirror capability');
        return methods.mirrorElements(normalized, ids, params);
      });
      const live = modelEditTarget(store.getState(), normalized);
      if (!live) throw new Error('Mirrored model is no longer loaded');
      const changed = expandAffectedSet(live.dataStore, live.view, result.map(ref => ref.expressId), 'hostsChanged');
      completePhysicalEdit(store, normalized, undoBefore, [...changed], params.copy ? 'created' : 'shape');
      return result;
    },
    addClassification(modelId, params) {
      const { normalized, writable } = target(modelId);
      return recordModellingEdit(writable, normalized, methods => {
        if (!methods.addClassification) throw new Error('Missing classification capability');
        return methods.addClassification(normalized, params);
      });
    },
    assignClassification(modelId, classificationId, objects) {
      const { normalized, writable } = target(modelId);
      return recordModellingEdit(writable, normalized, methods => {
        if (!methods.assignClassification) throw new Error('Missing classification capability');
        return methods.assignClassification(normalized, classificationId, objects);
      });
    },
  };
}
