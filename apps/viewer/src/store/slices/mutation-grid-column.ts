/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Record the complete grid placement and column graph as one modelling edit
 * (#6232), using the same live target and Undo/Redo path as authored grids. */
import {
  addColumnOnGridToStore, resolveSpatialAnchor,
  type ColumnInStoreParams, type ProfiledColumnInStoreParams, type GridColumnBinding,
} from '@ifc-lite/create';
import { registerAuthoredElement } from '@/utils/spatialHierarchy.js';
import { mutationDenial } from '../mutation-permission.js';
import { modelEditTarget, recordModellingEdit, type ModellingStore } from './mutation-modelling-records.js';
import { completeAuthoredGeometry } from './authoredGeometryCompletion.js';

export function addGridColumnIn(
  store: ModellingStore,
  modelId: string,
  storeyId: number,
  params: ColumnInStoreParams | ProfiledColumnInStoreParams,
  binding: GridColumnBinding,
): { expressId: number } | { error: string } {
  const denial = mutationDenial(store.getState(), modelId);
  if (denial) return { error: denial };
  const target = modelEditTarget(store.getState(), modelId);
  if (!target) return { error: `No model loaded for id "${modelId}"` };
  try {
    const build = recordModellingEdit(store, modelId, (_methods, draft) => addColumnOnGridToStore(
      draft, target.dataStore, resolveSpatialAnchor(target.dataStore, storeyId, draft.getMutationView()), params, binding,
    ));
    if (target.dataStore.spatialHierarchy) {
      const name = target.view.getNewEntity(build.columnId)?.attributes[2];
      registerAuthoredElement(target.dataStore.spatialHierarchy, storeyId, build.columnId, 'IFCCOLUMN', typeof name === 'string' ? name : '');
    }
    completeAuthoredGeometry(store.getState, modelId, target.dataStore, storeyId, build.columnId, { kind: 'column', params });
    return { expressId: build.columnId };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
