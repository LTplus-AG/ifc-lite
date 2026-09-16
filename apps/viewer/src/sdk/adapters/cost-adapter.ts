/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createCostBackend, type CostBackendMethods } from '@ifc-lite/sdk';
import type { StoreApi } from './types.js';
import { getDefaultModelId, getModelForRef } from './model-compat.js';

export function createCostAdapter(store: StoreApi): CostBackendMethods {
  return createCostBackend(requestedModelId => {
    const state = store.getState();
    const modelId = requestedModelId ?? getDefaultModelId(state);
    if (!modelId) throw new Error('bim.cost requires a loaded IFC model');
    const model = getModelForRef(state, modelId);
    if (!model) throw new Error(`Unknown modelId '${modelId}'`);
    if (!model.ifcDataStore) throw new Error(`bim.cost requires loaded IFC source bytes for model '${modelId}'`);
    return { modelId, store: model.ifcDataStore };
  });
}
