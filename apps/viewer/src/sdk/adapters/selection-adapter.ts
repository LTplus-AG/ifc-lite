/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EntityRef, SelectionBackendMethods } from '@ifc-lite/sdk';
import { resolvedTypeName } from '@ifc-lite/data';
import type { StoreApi } from './types.js';
import { toGlobalIdForRef } from '../../store/globalId.js';
import { getModelForRef } from './model-compat.js';
import { getMutationViewForModel } from './mutation-view.js';

export function createSelectionAdapter(store: StoreApi): SelectionBackendMethods {
  function valid(ref: EntityRef): boolean {
    const model = getModelForRef(store.getState(), ref.modelId);
    const view = getMutationViewForModel(store, ref.modelId);
    return !!model && !view?.isDeleted(ref.expressId)
      && !!((model.ifcDataStore && resolvedTypeName(model.ifcDataStore.entities, ref.expressId)) || view?.getNewEntity(ref.expressId));
  }
  return {
    get() {
      const state = store.getState();
      const ids = state.selectedEntityIds.size > 0 ? [...state.selectedEntityIds]
        : state.selectedEntityId === null ? [] : [state.selectedEntityId];
      return ids.flatMap(id => {
        const resolved = state.resolveGlobalIdFromModels(id);
        const ref = resolved ? { modelId: resolved.modelId, expressId: resolved.expressId }
          : state.models.size === 0 && state.ifcDataStore ? { modelId: 'default', expressId: id } : undefined;
        return ref && valid(ref) ? [ref] : [];
      });
    },
    set(refs: EntityRef[]) {
      const state = store.getState();
      // Both channels must be written: numeric ids highlight, refs identify the
      // property source. Validate before converting; a removed model can reuse ids.
      const unique = new Map<string, EntityRef>();
      for (const ref of refs) {
        if (!valid(ref)) continue;
        unique.set(`${ref.modelId}:${ref.expressId}`, ref);
      }
      const selected = [...unique.values()];
      state.clearEntitySelection();
      if (selected.length) {
        state.setSelectedEntity(selected[selected.length - 1]);
        state.addEntitiesToSelection(selected);
        state.setSelectedEntityIds(selected.map(ref => toGlobalIdForRef(state.models, ref)));
      }
      return undefined;
    },
  };
}
