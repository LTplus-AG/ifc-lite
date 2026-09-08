/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { propertyValueTypeOf, type EntityRef, type MutateBackendMethods } from '@ifc-lite/sdk';
import type { StoreApi } from './types.js';
import { getOrCreateMutationView, normalizeMutationModelId } from './mutation-view.js';

export function createMutateAdapter(store: StoreApi): MutateBackendMethods {
  return {
    setProperty(ref: EntityRef, psetName: string, propName: string, value: string | number | boolean) {
      const state = store.getState();
      const normalizedModelId = normalizeMutationModelId(state, ref.modelId);
      if (!getOrCreateMutationView(store, ref.modelId)) return undefined;
      // Classify before storing: mutationSlice.setProperty defaults valueType to
      // String, so a bare forward wrote IFCLABEL('true') for a boolean — the
      // same defect the headless adapter documents.
      state.setProperty?.(
        normalizedModelId, ref.expressId, psetName, propName, value, propertyValueTypeOf(value),
      );
      return undefined;
    },
    setAttribute(ref: EntityRef, attrName: string, value: string) {
      const state = store.getState();
      const normalizedModelId = normalizeMutationModelId(state, ref.modelId);
      if (!getOrCreateMutationView(store, ref.modelId)) return undefined;
      state.setAttribute?.(normalizedModelId, ref.expressId, attrName, value);
      return undefined;
    },
    deleteProperty(ref: EntityRef, psetName: string, propName: string) {
      const state = store.getState();
      const normalizedModelId = normalizeMutationModelId(state, ref.modelId);
      if (!getOrCreateMutationView(store, ref.modelId)) return undefined;
      state.deleteProperty?.(normalizedModelId, ref.expressId, psetName, propName);
      return undefined;
    },
    undo(modelId: string) {
      const state = store.getState();
      const normalizedModelId = normalizeMutationModelId(state, modelId);
      if (state.canUndo?.(normalizedModelId)) {
        state.undo?.(normalizedModelId);
        return true;
      }
      return false;
    },
    redo(modelId: string) {
      const state = store.getState();
      const normalizedModelId = normalizeMutationModelId(state, modelId);
      if (state.canRedo?.(normalizedModelId)) {
        state.redo?.(normalizedModelId);
        return true;
      }
      return false;
    },
    batchBegin() {
      // TODO: Implement batch grouping when the mutation store supports it.
      // For now, individual mutations each create their own undo step.
      return undefined;
    },
    batchEnd() {
      return undefined;
    },
  };
}
