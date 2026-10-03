/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { arrayCopyTransforms } from '@ifc-lite/create';
import type { RemeshCause } from '@ifc-lite/export';
import { joinedPartnersOf } from '@/store/slices/mutation-wall-joins';
import type { createModellingStoreBackend } from '@ifc-lite/sdk';
import type { StoreApi } from './types.js';
import { normalizeMutationModelId } from './mutation-view.js';
import { modelEditTarget, recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { mutationDenial } from '@/store/mutation-permission';
import { remeshAfterCommit } from '@/lib/remesh/remesh-registry';
import { copyElements } from '@/lib/commands/modeling/copy-elements';
import { effectiveStoreyId } from '@/lib/effective-storey';
import { registerAuthoredElement } from '@/utils/spatialHierarchy';

type Methods = ReturnType<typeof createModellingStoreBackend>;

/** Renderer/history adapters over exactly the same public SDK mutation cores. */
export function physicalMutationTracking(store: StoreApi): Pick<Methods,
  'copyElements' | 'duplicateElement' | 'arrayElements' | 'transformElements' | 'setElementSize' | 'resizeWall' | 'splitElements' | 'trimExtendElement'> {
  const target = (modelId: string) => {
    const normalized = normalizeMutationModelId(store.getState(), modelId);
    const denial = mutationDenial(store.getState(), normalized);
    if (denial) throw new Error(denial);
    const setState = store.setState;
    if (!setState) throw new Error('Physical editing requires a writable viewer store');
    return { normalized, writable: { ...store, setState } };
  };
  function edit<T>(modelId: string, operation: (methods: Methods, normalized: string) => T, ids: (result: T) => readonly number[], cause: RemeshCause = 'hostsChanged'): T {
    const { normalized, writable } = target(modelId);
    const undoBefore = store.getState().undoStacks.get(normalized)?.length ?? 0;
    const result = recordModellingEdit(writable, normalized, methods => operation(methods, normalized));
    completePhysicalEdit(store, normalized, undoBefore, ids(result), cause);
    return result;
  }
  const copy: NonNullable<Methods['copyElements']> = (modelId, expressIds, transforms) => {
    const { normalized, writable } = target(modelId);
    const undoBefore = store.getState().undoStacks.get(normalized)?.length ?? 0;
    const result = copyElements(writable, normalized, expressIds, transforms);
    completePhysicalEdit(store, normalized, undoBefore, result.meshed, 'created');
    return result.copies.map(expressId => ({ modelId: normalized, expressId }));
  };
  return {
    copyElements: copy,
    duplicateElement(ref, options) {
      const { normalized, writable } = target(ref.modelId);
      const undoBefore = store.getState().undoStacks.get(normalized)?.length ?? 0;
      const result = copyElements(writable, normalized, [ref.expressId], [{ offset: options.offset }], {
        duplicate: { name: options.Name },
      });
      completePhysicalEdit(store, normalized, undoBefore, result.meshed, 'created');
      const expressId = result.copies[0];
      if (expressId === undefined) throw new Error('Duplicate did not produce an element');
      return { modelId: normalized, expressId };
    },
    arrayElements(modelId, expressIds, params) {
      const transforms = arrayCopyTransforms(params);
      if (!transforms) throw new Error('Array requires an anchor and a nonzero linear direction');
      return copy(modelId, expressIds, transforms);
    },
    transformElements(modelId, ids, operation) {
      return edit(modelId, (methods, normalized) => {
        if (!methods.transformElements) throw new Error('Missing transform capability');
        return methods.transformElements(normalized, ids, operation);
      }, refs => refs.map(ref => ref.expressId));
    },
    setElementSize(ref, patch) {
      return edit(ref.modelId, (methods, normalized) => {
        if (!methods.setElementSize) throw new Error('Missing size capability');
        return methods.setElementSize({ ...ref, modelId: normalized }, patch);
      }, refs => refs.map(ref => ref.expressId));
    },
    resizeWall(ref, start, end, options) {
      return edit(ref.modelId, (methods, normalized) => {
        if (!methods.resizeWall) throw new Error('Missing endpoint capability');
        return methods.resizeWall({ ...ref, modelId: normalized }, start, end, options);
      }, refs => refs.map(ref => ref.expressId));
    },
    splitElements(modelId, requests) {
      return edit(modelId, (methods, normalized) => {
        if (!methods.splitElements) throw new Error('Missing split capability');
        return methods.splitElements(normalized, requests);
      }, results => {
        const ids = results.flatMap(result => [result.source.expressId, result.added.expressId]);
        const normalized = normalizeMutationModelId(store.getState(), modelId);
        return [...ids, ...joinedPartnersOf(store.getState(), normalized, ids)];
      }, 'created');
    },
    trimExtendElement(ref, params) {
      return edit(ref.modelId, (methods, normalized) => {
        if (!methods.trimExtendElement) throw new Error('Missing trim/extend capability');
        return methods.trimExtendElement({ ...ref, modelId: normalized }, params);
      }, refs => refs.map(ref => ref.expressId));
    },
  };
}

export function completePhysicalEdit(store: StoreApi, modelId: string, undoBefore: number, ids: readonly number[], cause: RemeshCause = 'hostsChanged'): void {
    const state = store.getState(), stack = state.undoStacks.get(modelId) ?? [];
    const last = stack.length > undoBefore ? stack.at(-1) : undefined;
    const target = modelEditTarget(state, modelId);
    const data = target?.dataStore, view = target?.view;
    if (data?.spatialHierarchy && view) for (const id of ids) {
      const record = view.getNewEntity(id);
      const storeyId = effectiveStoreyId(data, view, id);
      if (record && storeyId !== undefined) registerAuthoredElement(data.spatialHierarchy, storeyId, id, record.type.toUpperCase(), typeof record.attributes[2] === 'string' ? record.attributes[2] : '');
    }
    remeshAfterCommit(store.getState, modelId, last ? state.mutationBatchTags.get(last.id) ?? null : null, [...ids], cause);
}
