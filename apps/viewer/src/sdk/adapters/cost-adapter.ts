/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createCostBackend, type CostBackendMethods } from '@ifc-lite/sdk';
import type { StoreApi } from './types.js';
import { getDefaultModelId, getModelForRef } from './model-compat.js';
import { getMutationViewForModel } from './mutation-view.js';

/**
 * `bim.cost` over a loaded viewer model.
 *
 * The model's `MutablePropertyView` is handed straight to the backend as the
 * pending-edit overlay (#4857): it structurally satisfies the parser's
 * `CostMutationOverlay` (`isDeleted` + `getAttributeMutationsForEntity`), so
 * there is no adapter shape in between to drift. `getMutationViewForModel`
 * returns `null` until the session actually edits the model, and `null`
 * becomes `undefined` here — an unedited model keeps the cached, on-disk read
 * path it has always taken.
 *
 * This is the same view `export.ifc` passes to `StepExporter` when
 * `includeMutations` is not `false`, which is what makes the read model and
 * the exported bytes describe one file rather than two.
 */
export function createCostAdapter(store: StoreApi): CostBackendMethods {
  return createCostBackend(requestedModelId => {
    const state = store.getState();
    const modelId = requestedModelId ?? getDefaultModelId(state);
    if (!modelId) throw new Error('bim.cost requires a loaded IFC model');
    const model = getModelForRef(state, modelId);
    if (!model) throw new Error(`Unknown modelId '${modelId}'`);
    if (!model.ifcDataStore) throw new Error(`bim.cost requires loaded IFC source bytes for model '${modelId}'`);
    const overlay = getMutationViewForModel(store, modelId) ?? undefined;
    return { modelId, store: model.ifcDataStore, ...(overlay ? { overlay } : {}) };
  });
}
