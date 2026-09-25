/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { propertyValueTypeOf, type EntityRef, type MutateBackendMethods } from '@ifc-lite/sdk';
import type { StoreApi } from './types.js';
import { getOrCreateMutationView, normalizeMutationModelId } from './mutation-view.js';
import { newMutationBatchId } from '../../store/slices/mutation-batch-tags.js';
import { openBackendWriteCapture, trackBackendWrite, type BackendWriteCapture } from './backend-write-capture.js';

export function createMutateAdapter(store: StoreApi): MutateBackendMethods {
  // Open `bim.mutate.batch()` scopes, innermost last. A scope holds a
  // backend-write capture; on close, every mutation the SDK backend created
  // meanwhile — property, attribute, positional and store/create mutations
  // alike — is tagged with one batch id so undo / redo revert it as one
  // step. An edit made through the UI while an async batch is open never
  // goes through the backend, so it keeps its own undo step (#5634). Nested
  // scopes fold into the outermost one: the outer tag is written last.
  const openBatches: Array<{ label: string; capture: BackendWriteCapture }> = [];
  const methods: MutateBackendMethods = {
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
    batchBegin(label: string) {
      openBatches.push({ label, capture: openBackendWriteCapture() });
    },
    batchEnd(label: string) {
      const scope = openBatches.pop();
      if (!scope) return;
      if (scope.label !== label) {
        openBatches.push(scope);
        throw new Error(`bim.mutate.batchEnd("${label}") does not match the open batch "${scope.label}"`);
      }
      scope.capture.close();
      store.getState().tagMutationBatch?.([...scope.capture.ids], newMutationBatchId());
    },
  };
  // Its own writes are tracked here too, so a standalone mutate adapter
  // attributes them; `LocalBackend` tracks every other namespace.
  return {
    ...methods,
    setProperty: (...args) => trackBackendWrite(store, () => methods.setProperty(...args)),
    setAttribute: (...args) => trackBackendWrite(store, () => methods.setAttribute(...args)),
    deleteProperty: (...args) => trackBackendWrite(store, () => methods.deleteProperty(...args)),
    undo: (modelId) => trackBackendWrite(store, () => methods.undo(modelId)),
    redo: (modelId) => trackBackendWrite(store, () => methods.redo(modelId)),
  };
}
