/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { addOrdinaryElementInStore, resolveSpatialAnchor, type OrdinaryInStoreElement } from '@ifc-lite/create';
import type { CostStoreModelResolution } from './cost-store-backend.js';
import type { EntityRef, StoreBackendMethods } from './types.js';

/** Existing ordinary creation methods, without adding required backend members. */
export type OrdinaryStoreBackendMethods = Pick<StoreBackendMethods,
  'addWall' | 'addColumn' | 'addSlab' | 'addBeam' | 'addSpace' | 'addRoof' | 'addPlate' | 'addMember'>;

/** Resolve each call against its live model and delegate the IFC commit to
 * create's atomic dispatcher (#6232 D5). Anchor resolution retains its strict
 * existing-placement policy. Hosts add permission, publication and history
 * behavior outside this factory; MCP supplies its compound-recording draft. */
export function createOrdinaryStoreBackend(
  resolve: (modelId: string) => Pick<CostStoreModelResolution, 'modelId' | 'store' | 'editor' | 'mutationView'>,
): OrdinaryStoreBackendMethods {
  const add = (modelId: string, storeyId: number, element: OrdinaryInStoreElement): EntityRef => {
    const model = resolve(modelId);
    const anchor = resolveSpatialAnchor(model.store, storeyId, model.mutationView);
    const expressId = addOrdinaryElementInStore(model.editor, anchor, element);
    return { modelId: model.modelId, expressId };
  };
  return {
    addWall: (modelId, storeyId, params) => add(modelId, storeyId, { kind: 'wall', params }),
    addColumn: (modelId, storeyId, params) => add(modelId, storeyId, { kind: 'column', params }),
    addSlab: (modelId, storeyId, params) => add(modelId, storeyId, { kind: 'slab', params }),
    addBeam: (modelId, storeyId, params) => add(modelId, storeyId, { kind: 'beam', params }),
    addSpace: (modelId, storeyId, params) => add(modelId, storeyId, { kind: 'space', params }),
    addRoof: (modelId, storeyId, params) => add(modelId, storeyId, { kind: 'roof', params }),
    addPlate: (modelId, storeyId, params) => add(modelId, storeyId, { kind: 'plate', params }),
    addMember: (modelId, storeyId, params) => add(modelId, storeyId, { kind: 'member', params }),
  };
}
