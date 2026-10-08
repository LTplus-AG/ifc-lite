/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232: canonical replacement plus one viewer history/room/mesh completion. */
import { replaceElementInStore, resolveSpatialAnchor, type InStoreReplacementElement } from '@ifc-lite/create';
import { mutationDenial } from '../mutation-permission.js';
import { recordModellingCommit, type ModellingStore } from './mutation-modelling-records.js';
import { ensureStoreyPlacement } from './storeyPlacement.js';
import { completeEntityRemoval } from './mutation-mesh-stash.js';
import { completeStairRailingGeometry } from './mutation-stair-railing.js';

/** The UI's optional storey placement is prepared inside the sole core draft.
 * No tree, mesh, room or undo effect occurs until that atomic commit succeeds. */
export function replaceElementIn(
  store: ModellingStore, modelId: string, oldId: number,
  storeyId: number, element: InStoreReplacementElement,
): number {
  const denial = mutationDenial(store.getState(), modelId);
  if (denial) throw new Error(`bim.store.replaceElement: ${denial}`);
  const undoBefore = store.getState().undoStacks.get(modelId)?.length ?? 0;
  const built = recordModellingCommit(store, modelId, (editor, dataStore) =>
    replaceElementInStore(dataStore, editor, oldId, draft => {
      ensureStoreyPlacement(dataStore, draft, storeyId);
      return resolveSpatialAnchor(dataStore, storeyId, draft.getMutationView());
    }, element));
  for (const id of built.removedIds) {
    completeEntityRemoval(store.getState, store.setState, modelId, id,
      store.getState().removedNewEntities.get(`${modelId}:${id}`));
  }
  if (element.kind === 'stair' || element.kind === 'railing') {
    const state = store.getState(), stack = state.undoStacks.get(modelId) ?? [];
    const last = stack.length > undoBefore ? stack.at(-1) : undefined;
    completeStairRailingGeometry(store, modelId, storeyId, built,
      element.kind === 'stair' ? 'IFCSTAIR' : 'IFCRAILING',
      last ? state.mutationBatchTags.get(last.id) ?? null : null);
  } else {
    store.getState().recordAuthoredElement(modelId, storeyId, built.expressId, element, { historyRecorded: true });
  }
  return built.expressId;
}
