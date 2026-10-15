/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createAlignCommandBackend, type ModellingStoreModelResolver, type AlignGeometryProvider } from '../index.js';
import { recordCompoundMutation, StoreEditor } from '@ifc-lite/mutations';

export function createHeadlessAlignBackend(resolve: ModellingStoreModelResolver, provide: AlignGeometryProvider) {
  return createAlignCommandBackend(resolve, provide, {
    historyHead: modelId => resolve(modelId).mutationView.getMutations().map(m => m.id).join('|'),
    record: (modelId, write) => {
      const model = resolve(modelId);
      return recordCompoundMutation(model.mutationView, mutationView => write({ ...model, mutationView, editor: new StoreEditor(model.store, mutationView) }));
    },
  });
}
