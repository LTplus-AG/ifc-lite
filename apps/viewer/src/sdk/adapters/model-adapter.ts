/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ModelInfo, ModelBackendMethods } from '@ifc-lite/sdk';
import { iterateEffectiveEntityIds } from '@ifc-lite/mutations';
import type { StoreApi } from './types.js';
import { getAllModelEntries, LEGACY_MODEL_ID } from './model-compat.js';
import { getMutationViewForModel } from './mutation-view.js';

export function createModelAdapter(store: StoreApi): ModelBackendMethods {
  return {
    list() {
      const state = store.getState();
      const result: ModelInfo[] = [];
      for (const [modelId, model] of getAllModelEntries(state)) {
        const dataStore = model.ifcDataStore;
        const view = getMutationViewForModel(store, modelId);
        // A name/property/retype edit cannot change the number of entities.
        // Keep the large-model list() path constant-time until membership
        // actually changes in this model's overlay.
        // @raw-entity-enumeration-ok source table count is exact when the overlay has no creations or tombstones
        let entityCount = dataStore?.entities.count ?? 0;
        if (dataStore && view && (view.getNewEntities().length > 0 || view.getTombstones().size > 0)) {
          entityCount = 0;
          for (const _entity of iterateEffectiveEntityIds(
            dataStore,
            view,
            undefined,
            dataStore.entities.expressId,
          )) entityCount++;
        }
        result.push({
          id: model.id,
          name: model.name,
          schema: model.schemaVersion,
          schemaVersion: model.schemaVersion,
          entityCount,
          fileSize: model.fileSize,
          loadedAt: model.loadedAt,
        });
      }
      return result;
    },
    activeId() {
      const state = store.getState();
      // For legacy single-model, return the sentinel ID when no active model is set
      return state.activeModelId ?? (state.models.size === 0 && state.ifcDataStore ? LEGACY_MODEL_ID : null);
    },

    loadIfc(content: string, filename: string) {
      // Create a File from IFC content and dispatch the standard load event.
      // MainToolbar listens for 'ifc-lite:load-file' and routes to loadFile().
      const blob = new Blob([content], { type: 'application/x-step' });
      const file = new File([blob], filename || 'created.ifc', { type: 'application/x-step' });
      window.dispatchEvent(new CustomEvent('ifc-lite:load-file', { detail: file }));
    },
  };
}
