/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */



import { mutationDenial } from '../mutation-permission.js';
import type { ViewerState } from '../index.js';
import { readElementSizeInStore, setElementSizeInStore, type ElementSize, type ElementSizePatch, type ElementSizeOutcome } from '../../../../../packages/create/src/in-store/element-size-edit.js';
import { modelEditTarget, recordModellingEdit, type ModellingStore } from './mutation-modelling-records.js';
export type { ElementSize, ElementSizePatch, ElementSizeOutcome } from '../../../../../packages/create/src/in-store/element-size-edit.js';

export function readElementSize(state: ViewerState, modelId: string, expressId: number): ElementSize | null {
  const target = modelEditTarget(state, modelId);
  return target ? readElementSizeInStore(target, expressId) : null;
}

export function setElementSize(store: ModellingStore, modelId: string, expressId: number, patch: ElementSizePatch): ElementSizeOutcome {
  const denial = mutationDenial(store.getState(), modelId);
  if (denial) return { ok: false, reason: denial };
  const target = modelEditTarget(store.getState(), modelId);
  if (!target) return { ok: false, reason: `No model loaded for id "${modelId}"` };
  try {
    return recordModellingEdit(store, modelId, (_methods, draft) => {
      const result = setElementSizeInStore({ ...target, view: draft.getMutationView(), editor: draft }, expressId, patch);
      if (!result.ok) throw new Error(result.reason);
      return result;
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
