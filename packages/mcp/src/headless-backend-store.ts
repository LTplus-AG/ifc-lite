/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Store adapter kept apart from read/export adapters (#6232 D5). */
import type { StoreBackendMethods } from '@ifc-lite/sdk';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { unsupportedStoreAuthoring } from './headless-backend-store-stubs.js';
import { createHostedStoreBackend } from './headless-backend-modelling.js';

export function createHeadlessStoreAdapter(
  dataStore: IfcDataStore, modelId: string, get: () => StoreEditor, assertKnownModelId: (id: string) => void,
): StoreBackendMethods {
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
    // The element-creation helpers (addWall, addSlab, …) are not used by the
    // MCP server in v0.1 — agent flows go through entity_create with raw
    // attributes. Stubs throw so a misconfigured caller fails loudly.
    addColumn: () => { throw new Error('addColumn not supported in MCP v0.1; use entity_create'); },
    addWall: () => { throw new Error('addWall not supported in MCP v0.1; use entity_create'); },
    addSlab: () => { throw new Error('addSlab not supported in MCP v0.1; use entity_create'); },
    addBeam: () => { throw new Error('addBeam not supported in MCP v0.1; use entity_create'); },
    addDoor: () => { throw new Error('addDoor not supported in MCP v0.1; use entity_create'); },
    addWindow: () => { throw new Error('addWindow not supported in MCP v0.1; use entity_create'); },
    addSpace: () => { throw new Error('addSpace not supported in MCP v0.1; use entity_create'); },
    addRoof: () => { throw new Error('addRoof not supported in MCP v0.1; use entity_create'); },
    addPlate: () => { throw new Error('addPlate not supported in MCP v0.1; use entity_create'); },
    addMember: () => { throw new Error('addMember not supported in MCP v0.1; use entity_create'); },
    ...unsupportedStoreAuthoring(),
    ...createHostedStoreBackend(requestedModelId => {
      if (requestedModelId !== undefined) assertKnownModelId(requestedModelId);
      const editor = get();
      const mutationView = editor.getMutationView();
      return {
        modelId, store: dataStore, editor, mutationView,
        ownerHistoryId: null, // Hosted placement resolves the host's live anchor in the shared core.
      };
    }),
  };
}
