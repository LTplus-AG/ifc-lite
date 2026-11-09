/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Roof creation publishes its body and footprint before committing (#9356 review). */
import { addOrdinaryElementInStore, resolveSpatialAnchor, type RoofInStoreParams } from '@ifc-lite/create';
import { mutationDenial } from '../mutation-permission.js';
import { modelEditTarget, recordResolvedModellingCommit, type ModellingStore } from './mutation-modelling-records.js';
import { mirrorNewRoofDefinition } from './mutation-roof.js';
import { ensureStoreyPlacement } from './storeyPlacement.js';

export function createRoofIn(store: ModellingStore, modelId: string, storeyExpressId: number,
  params: RoofInStoreParams): { expressId: number } | { error: string } {
  const refusal = mutationDenial(store.getState(), modelId);
  if (refusal) return { error: refusal };
  if (!store.getState().mutationViews.has(modelId)) return { error: 'Model has no editable mutation view yet' };
  const target = modelEditTarget(store.getState(), modelId);
  if (!target) return { error: `No model loaded for id "${modelId}"` };
  const element = { kind: 'roof' as const, params };
  let entityId: number;
  try {
    entityId = recordResolvedModellingCommit(store, target, draft =>
      addOrdinaryElementInStore(draft, editor => {
        ensureStoreyPlacement(target.dataStore, editor, storeyExpressId);
        return resolveSpatialAnchor(target.dataStore, storeyExpressId, editor.getMutationView());
      }, element), undefined, true,
    (id, view) => mirrorNewRoofDefinition(store.getState(), modelId, id, view));
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Failed to add roof' };
  }
  store.getState().recordAuthoredElement(modelId, storeyExpressId, entityId, element, { historyRecorded: true });
  return { expressId: entityId };
}
