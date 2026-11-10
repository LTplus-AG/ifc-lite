/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** `bim.store.editRoof` against a resolved model; hosts add history and re-meshing around it. */
import { editFootprintRoofInStore } from '@ifc-lite/create';
import type { CostStoreModelResolution } from './cost-store-backend.js';
import type { RoofStoreBackendMethods } from './store-roof-types.js';

export function createRoofStoreBackend(
  resolve: (modelId: string) => Pick<CostStoreModelResolution, 'modelId' | 'store' | 'editor'>,
): Required<RoofStoreBackendMethods> {
  return {
    editRoof(ref, patch) {
      const model = resolve(ref.modelId);
      editFootprintRoofInStore(model.store, model.editor, ref.expressId, patch);
      return { modelId: model.modelId, expressId: ref.expressId };
    },
  };
}
