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
import type { createModellingStoreBackend, EntityRef } from '@ifc-lite/sdk';
import { createStoreMutationTracker } from './store-adapter-cost.js';
import { normalizeMutationModelId } from './mutation-view.js';
import type { HostedFillSpec } from '@/store/slices/mutation-hosted-fill';
import type { StoreApi } from './types.js';

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
