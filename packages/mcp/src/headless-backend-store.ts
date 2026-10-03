/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Store adapter kept apart from read/export adapters (#6232 D5). */
import type { StoreBackendMethods } from '@ifc-lite/sdk';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { unsupportedStoreAuthoring } from './headless-backend-store-stubs.js';
import { createRecordedModellingBackend } from './headless-backend-modelling.js';

export function createHeadlessStoreAdapter(
  dataStore: IfcDataStore, modelId: string, get: () => StoreEditor, assertKnownModelId: (id: string) => void,
  getPeerScopes: () => import('@ifc-lite/create').ElementSplitOptions['globalIdScopes'],
): StoreBackendMethods {
  const resolveModel = (requestedModelId?: string) => {
    if (requestedModelId !== undefined) assertKnownModelId(requestedModelId);
    const editor = get();
    return { modelId, store: dataStore, editor, mutationView: editor.getMutationView(), ownerHistoryId: null, globalIdScopes: getPeerScopes() };
  };
  return {
    addEntity: (modelId, def) => {
      // The ref carries `modelId`, and `bim.mutate.*` refuses one this
      // backend does not answer for: echoing the caller's id back would mint
      // a ref the next write rejects, entity already created (#3764).
      assertKnownModelId(modelId);
      const ref = get().addEntity(def.type, def.attributes as Parameters<StoreEditor['addEntity']>[1]);
      return { modelId, expressId: ref.expressId };
    },
    removeEntity: (ref) => get().removeEntity(ref.expressId),
    setPositionalAttribute: (ref, index, value) => {
      get().setPositionalAttribute(ref.expressId, index, value as Parameters<StoreEditor['setPositionalAttribute']>[2]);
    },
    // Free door/window creation remains unsupported here. Hosted fills use
    // the canonical host-required API supplied by the recorded factory below.
    addDoor: () => { throw new Error('addDoor not supported in MCP v0.1; use entity_create'); },
    addWindow: () => { throw new Error('addWindow not supported in MCP v0.1; use entity_create'); },
    ...unsupportedStoreAuthoring(),
    ...createRecordedModellingBackend(resolveModel),
  };
}
