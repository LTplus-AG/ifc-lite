/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** `bim.store.editRoof` in the viewer: one undo step, then the roof is re-meshed. */

import type { RoofStoreBackendMethods } from '@ifc-lite/sdk';
import { normalizeMutationModelId } from './mutation-view.js';
import type { StoreApi } from './types.js';
import { editRoofIn } from '@/store/slices/mutation-roof';
import { remeshAfterCommit } from '@/lib/remesh/remesh-registry';

export function roofMutationTracking(store: StoreApi): Required<RoofStoreBackendMethods> {
  return {
    editRoof(ref, patch) {
      const normalized = normalizeMutationModelId(store.getState(), ref.modelId);
      const setState = store.setState;
      if (!setState) throw new Error('bim.store.editRoof: the adapter requires a writable store');
      const undoBefore = store.getState().undoStacks.get(normalized)?.length ?? 0;
      const outcome = editRoofIn({ ...store, setState }, normalized, ref.expressId, patch);
      if (!outcome.ok) throw new Error(`bim.store.editRoof: ${outcome.reason}`);
      const state = store.getState(), stack = state.undoStacks.get(normalized) ?? [];
      const last = stack.length > undoBefore ? stack.at(-1) : undefined;
      remeshAfterCommit(store.getState, normalized, last ? state.mutationBatchTags.get(last.id) ?? null : null, outcome.remesh, 'shape');
      return { modelId: normalized, expressId: ref.expressId };
    },
  };
}
