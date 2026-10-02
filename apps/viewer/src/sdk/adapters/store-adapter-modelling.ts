/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Collab gate, shared-room mirroring and undo bookkeeping for the #6232
 * `bim.store` modelling surface: openings, hosted doors/windows, type objects
 * and materials.
 *
 * An opening or hosted filling is written by the store's `addHostedFill`
 * action, the same one the Model workspace's placing commands commit through
 * (`mutation-hosted-fill.ts`): the compound graph (opening,
 * IfcRelVoidsElement, and for a door or window the filling,
 * IfcRelFillsElement and containment) lands on the undo stack as ONE batch,
 * so `Ctrl+Z` removes all of it, it reaches a shared room, and the host is
 * re-meshed with its void.
 *
 * Relationship writes (type and material assignments, layer sets) still take
 * the blunt-but-safe path of the cost relationship writes: mark the model
 * dirty and clear its undo history so `Ctrl+Z` can never cross them.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { removeStairInStore } from '@ifc-lite/create';
import type { createModellingStoreBackend, EntityRef } from '@ifc-lite/sdk';
import { createStoreMutationTracker } from './store-adapter-cost.js';
import { normalizeMutationModelId } from './mutation-view.js';
import type { HostedFillSpec } from '@/store/slices/mutation-hosted-fill';
import type { StoreApi } from './types.js';
import { recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { mutationDenial } from '@/store/mutation-permission';
import { remeshAfterCommit } from '@/lib/remesh/remesh-registry';
import { addStairIn, addRailingIn } from '@/store/slices/mutation-stair-railing';
import { replaceElementIn } from '@/store/slices/mutation-element-replacement';
import { completeEntityRemoval } from '@/store/slices/mutation-mesh-stash';

type ModellingMethods = ReturnType<typeof createModellingStoreBackend>;

export function withModellingMutationTracking(
  methods: ModellingMethods,
  store: StoreApi,
  resolve: (modelId: string) => { editor: StoreEditor; dataStore: IfcDataStore } | null,
): ModellingMethods {
  const { create, relationship } = createStoreMutationTracker(store, resolve, 'modelling');
  const compound = <A extends [string, ...unknown[]]>(fn: (...args: A) => EntityRef) =>
    relationship((...args: A): EntityRef => {
      const ref = fn(...args);
      store.getState().markCostRelationshipMutation(ref.modelId);
      return ref;
    });
  const hosted = <K extends HostedFillSpec['kind']>(kind: K, op: string) =>
    (modelId: string, hostExpressId: number, params: Extract<HostedFillSpec, { kind: K }>['params']): EntityRef => {
      const state = store.getState();
      const normalized = normalizeMutationModelId(state, modelId);
      const outcome = state.addHostedFill(normalized, hostExpressId, { kind, params } as HostedFillSpec);
      if ('error' in outcome) throw new Error(`bim.store.${op}: ${outcome.error}`);
      return { modelId: normalized, expressId: outcome.expressId };
    };
  return {
    replaceElement(ref, storeyExpressId, element) {
      const normalized = normalizeMutationModelId(store.getState(), ref.modelId);
      const setState = store.setState;
      if (!setState) throw new Error('bim.store.replaceElement: the adapter requires a writable store');
      const expressId = replaceElementIn({ ...store, setState }, normalized, ref.expressId, storeyExpressId, element);
      return { modelId: normalized, expressId };
    },
    removeStair(ref) {
      const normalized = normalizeMutationModelId(store.getState(), ref.modelId);
      const denial = mutationDenial(store.getState(), normalized);
      if (denial) throw new Error(`bim.store.removeStair: ${denial}`);
      const setState = store.setState;
      if (!setState) throw new Error('bim.store.removeStair: the adapter requires a writable store');
      const resolved = resolve(normalized);
      if (!resolved) throw new Error(`bim.store.removeStair: no model loaded for id "${ref.modelId}"`);
      const removed = recordModellingEdit({ ...store, setState }, normalized, (_methods, draft) =>
        removeStairInStore(resolved.dataStore, draft, ref.expressId));
      for (const id of [removed.stairId, removed.flightId]) {
        completeEntityRemoval(store.getState, setState, normalized, id,
          store.getState().removedNewEntities.get(`${normalized}:${id}`));
      }
      return true;
    },
    addStair(modelId, storeyExpressId, params) {
      const normalized = normalizeMutationModelId(store.getState(), modelId);
      const setState = store.setState;
      if (!setState) throw new Error('bim.store.addStair: the adapter requires a writable store');
      const outcome = addStairIn({ ...store, setState }, normalized, storeyExpressId, params);
      if ('error' in outcome) throw new Error(`bim.store.addStair: ${outcome.error}`);
      return { modelId: normalized, expressId: outcome.expressId };
    },
    addRailing(modelId, storeyExpressId, params) {
      const normalized = normalizeMutationModelId(store.getState(), modelId);
      const setState = store.setState;
      if (!setState) throw new Error('bim.store.addRailing: the adapter requires a writable store');
      const outcome = addRailingIn({ ...store, setState }, normalized, storeyExpressId, params);
      if ('error' in outcome) throw new Error(`bim.store.addRailing: ${outcome.error}`);
      return { modelId: normalized, expressId: outcome.expressId };
    },
    joinWalls(modelId, aExpressId, bExpressId, options) {
      const normalized = normalizeMutationModelId(store.getState(), modelId);
      const denial = mutationDenial(store.getState(), normalized);
      if (denial) throw new Error(`bim.store.joinWalls: ${denial}`);
      const setState = store.setState;
      if (!setState) throw new Error('bim.store.joinWalls: the adapter requires a writable store');
      const undoBefore = store.getState().undoStacks.get(normalized)?.length ?? 0;
      const result = recordModellingEdit({ ...store, setState }, normalized, methods => methods.joinWalls(normalized, aExpressId, bExpressId, options));
      const state = store.getState();
      const stack = state.undoStacks.get(normalized) ?? [];
      const last = stack.length > undoBefore ? stack.at(-1) : undefined;
      remeshAfterCommit(store.getState, normalized, last ? state.mutationBatchTags.get(last.id) ?? null : null, [aExpressId, bExpressId], 'shape');
      return result;
    },
    addOpening: hosted('opening', 'addOpening'),
    addHostedDoor: hosted('door', 'addHostedDoor'),
    addHostedWindow: hosted('window', 'addHostedWindow'),
    // Single records with no relationship: one CREATE_ENTITY entry inverts them.
    addElementType: relationship((modelId: string, params: Parameters<ModellingMethods['addElementType']>[1]) => {
      const ref = methods.addElementType(modelId, params);
      store.getState().pushCreateEntityUndo(ref.modelId, ref.expressId, params.Type.toUpperCase());
      return ref;
    }),
    addMaterial: create('IFCMATERIAL', methods.addMaterial),
    addMaterialLayerSetUsage: create('IFCMATERIALLAYERSETUSAGE', methods.addMaterialLayerSetUsage),
    // A layer set is several records; the assignments rewrite or remove
    // existing IfcRel* rows the objects move out of.
    addMaterialLayerSet: compound(methods.addMaterialLayerSet),
    assignType: compound(methods.assignType),
    assignMaterial: compound(methods.assignMaterial),
  };
}
