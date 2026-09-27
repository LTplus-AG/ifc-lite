/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Collab gate, shared-room mirroring and undo bookkeeping for the #6232
 * `bim.store` modelling surface: openings, hosted doors/windows, type objects
 * and materials.
 *
 * An opening or hosted filling writes a compound graph — opening, IfcRelVoidsElement, and for a
 * hosted door/window the filling, IfcRelFillsElement and containment — that a
 * single `CREATE_ENTITY` undo entry cannot invert: undoing only the door would
 * leave IfcRelFillsElement pointing at a deleted record. Until the authoring
 * session records one undo batch per command (#6232 M1), these take the same
 * blunt-but-safe path as the cost relationship writes: mark the model dirty
 * and clear its undo history so `Ctrl+Z` can never cross the untracked write.
 *
 * The renderer is not updated here: the host's re-cut mesh and the filling's
 * mesh arrive with overlay re-tessellation (#6232 M1); the export is correct
 * already.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { createModellingStoreBackend, EntityRef } from '@ifc-lite/sdk';
import { createStoreMutationTracker } from './store-adapter-cost.js';
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
  return {
    addOpening: compound(methods.addOpening),
    addHostedDoor: compound(methods.addHostedDoor),
    addHostedWindow: compound(methods.addHostedWindow),
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
