/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** A roof edit is one compound mutation record, so one undo reverts all of it. */
import { recordCompoundMutation, StoreEditor } from '@ifc-lite/mutations';
import type { ModellingStoreModelResolver } from '../store-modelling-backend.js';
import { createRoofStoreBackend } from '../store-roof-backend.js';
import type { RoofStoreBackendMethods } from '../store-roof-types.js';

export function createRecordedRoofBackend(resolve: ModellingStoreModelResolver): Required<RoofStoreBackendMethods> {
  return {
    editRoof: (ref, patch) => {
      const model = resolve(ref.modelId);
      return recordCompoundMutation(model.mutationView, (draft) =>
        createRoofStoreBackend(() => ({ ...model, editor: new StoreEditor(model.store, draft) })).editRoof(ref, patch));
    },
  };
}
