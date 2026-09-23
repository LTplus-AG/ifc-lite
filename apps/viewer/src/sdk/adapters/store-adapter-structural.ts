/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Collab gate + shared-room mirroring for `bim.store.addStructural*` (#5167).
 *
 * The structural surface is spread in from a shared SDK factory, exactly like
 * cost. Spreading it raw would reach the `@ifc-lite/create` builders and mutate
 * the local overlay even when `canCollabEdit()` is false, and in a shared room
 * the authored entities and their `IfcRel*` rows would never be published — so
 * they would be discarded the next time reconstruction replaced the overlay.
 *
 * The gate and the mirror are the same ones cost uses; only the undo entity
 * types and the failure label differ.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { createStructuralStoreBackend } from '@ifc-lite/sdk';
import { createStoreMutationTracker } from './store-adapter-cost.js';
import type { StoreApi } from './types.js';

type StructuralMethods = ReturnType<typeof createStructuralStoreBackend>;

export function withStructuralMutationTracking(
  methods: StructuralMethods,
  store: StoreApi,
  resolve: (modelId: string) => { editor: StoreEditor; dataStore: IfcDataStore } | null,
): StructuralMethods {
  const { create } = createStoreMutationTracker(store, resolve, 'structural');
  return {
    ...methods,
    addStructuralAnalysisModel: create('IFCSTRUCTURALANALYSISMODEL', methods.addStructuralAnalysisModel),
    addStructuralCurveMember: create('IFCSTRUCTURALCURVEMEMBER', methods.addStructuralCurveMember),
    addStructuralPointConnection: create('IFCSTRUCTURALPOINTCONNECTION', methods.addStructuralPointConnection),
    addStructuralLoadGroup: create('IFCSTRUCTURALLOADGROUP', methods.addStructuralLoadGroup),
    addStructuralPointAction: create('IFCSTRUCTURALPOINTACTION', methods.addStructuralPointAction),
    addStructuralLinearAction: create('IFCSTRUCTURALLINEARACTION', methods.addStructuralLinearAction),
    // These are creates, not rewrites. Unlike the cost relationship methods —
    // which edit existing rows and clear unsafe undo history via
    // `markCostRelationshipMutation` — each of these authors a NEW `IfcRel*`
    // entity and returns its ref, so it needs its own CREATE_ENTITY undo entry
    // or the row is left unreachable by undo (#5167 review).
    connectStructuralMemberToConnection: create('IFCRELCONNECTSSTRUCTURALMEMBER', methods.connectStructuralMemberToConnection),
    connectStructuralActivityToItem: create('IFCRELCONNECTSSTRUCTURALACTIVITY', methods.connectStructuralActivityToItem),
    assignToStructuralGroup: create('IFCRELASSIGNSTOGROUP', methods.assignToStructuralGroup),
  };
}
