/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */



import { setWallSectionInStore, type WallSection, type WallSectionOutcome } from '../../../../../packages/create/src/in-store/wall-section-edit.js';
import { mutationDenial } from '../mutation-permission.js';
import { modelEditTarget, recordModellingEdit, type ModellingStore } from './mutation-modelling-records.js';
export type { WallSection, WallSectionOutcome } from '../../../../../packages/create/src/in-store/wall-section-edit.js';

export function setWallSection(store: ModellingStore, modelId: string, expressId: number, section: WallSection): WallSectionOutcome {
  const denial = mutationDenial(store.getState(), modelId);
  if (denial) return { ok: false, reason: denial };
  const target = modelEditTarget(store.getState(), modelId);
  if (!target) return { ok: false, reason: `No model loaded for id "${modelId}"` };
  try {
    return recordModellingEdit(store, modelId, (_methods, draft) => {
      const result = setWallSectionInStore({ ...target, view: draft.getMutationView(), editor: draft }, expressId, section);
      if (!result.ok) throw new Error(result.reason);
      return result;
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
