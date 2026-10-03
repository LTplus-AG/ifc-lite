/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { transformElementsInStore, setElementSizeInStore, resizeWallInStore, splitElementsInStore, trimExtendElementInStore } from '@ifc-lite/create';
import type { ModellingStoreModelResolver } from './store-modelling-backend.js';
import type { PhysicalStoreBackendMethods } from './store-physical-types.js';
import type { EntityRef } from './types.js';

/** Host bookkeeping stays at the edge; all planning and graph writes are shared with the viewer. */
export function createPhysicalStoreBackend(resolve: ModellingStoreModelResolver): PhysicalStoreBackendMethods {
  const refs = (modelId: string, ids: readonly number[]): EntityRef[] => [...new Set(ids)].map(expressId => ({ modelId, expressId }));
  return {
    transformElements(modelId, selected, op) {
      const model = resolve(modelId);
      const result = model.editor.runAtomic(editor => transformElementsInStore({ dataStore: model.store, view: editor.getMutationView(), editor, selected, op }));
      return refs(model.modelId, result.remesh);
    },
    setElementSize(ref, patch) {
      const model = resolve(ref.modelId);
      const result = model.editor.runAtomic(editor => {
        const corePatch = patch.kind === 'wall' ? { kind: 'wall' as const, thickness: patch.Thickness, height: patch.Height }
          : patch.kind === 'slab' ? { kind: 'slab' as const, thickness: patch.Thickness }
          : { kind: 'linear' as const, length: patch.Depth, width: patch.XDim, cross: patch.YDim, fixed: patch.fixed };
        const changed = setElementSizeInStore({ dataStore: model.store, view: editor.getMutationView(), editor }, ref.expressId, corePatch);
        if (!changed.ok) throw new Error(changed.reason);
        return changed;
      });
      return refs(model.modelId, result.remesh);
    },
    resizeWall(ref, start, end, options = {}) {
      const model = resolve(ref.modelId);
      const result = model.editor.runAtomic(editor => {
        const changed = resizeWallInStore({ dataStore: model.store, view: editor.getMutationView(), editor }, ref.expressId, start, end, { moveJoinedEnds: options.moveJoinedEnds ?? true });
        if (!changed.ok) throw new Error(changed.reason);
        return changed;
      });
      return refs(model.modelId, result.walls);
    },
    splitElements(modelId, requests) {
      const model = resolve(modelId);
      return splitElementsInStore(model.store, model.editor, requests, { globalIdScopes: model.globalIdScopes }).map(result => {
        const ref = (expressId: number): EntityRef => ({ modelId: model.modelId, expressId });
        return { source: ref(result.sourceId), added: ref(result.addedId), left: ref(result.leftId), right: ref(result.rightId) };
      });
    },
    trimExtendElement(ref, params) {
      const model = resolve(ref.modelId);
      const result = trimExtendElementInStore(model.store, model.editor, ref.expressId, params);
      return refs(model.modelId, [result.expressId, ...result.walls]);
    },
  };
}
