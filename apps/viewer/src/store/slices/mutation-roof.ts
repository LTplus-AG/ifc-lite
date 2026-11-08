/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Edit a roof by footprint (#9296 round 3) as one undo step: the shared create
 * core rebuilds its planes inside `recordModellingEdit`'s atomic commit, so a
 * refusal writes nothing and `Ctrl+Z` restores the previous planes whole.
 */

import { editFootprintRoofInStore, type RoofFootprintEdit } from '@ifc-lite/create';
import { mutationDenial } from '../mutation-permission.js';
import { modelEditTarget, recordModellingEdit, type ModellingStore } from './mutation-modelling-records.js';

export type RoofEditOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function editRoofIn(store: ModellingStore, modelId: string, expressId: number, patch: RoofFootprintEdit): RoofEditOutcome {
  const refusal = mutationDenial(store.getState(), modelId);
  if (refusal) return { ok: false, reason: refusal };
  const target = modelEditTarget(store.getState(), modelId);
  if (!target) return { ok: false, reason: `No model loaded for id "${modelId}"` };
  try {
    recordModellingEdit(store, modelId, (_methods, draft) => editFootprintRoofInStore(target.dataStore, draft, expressId, patch));
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
