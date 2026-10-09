/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `bim.store` authoring surfaces the CLI backend composes from shared SDK
 * factories rather than hand-written methods: cost (#4857), structural
 * analysis (#5167 S.1), hosted elements and ordinary creation (#6232).
 *
 * Each takes the SAME per-call resolution, and that is the point of keeping
 * them together: an entity authored through one surface must be visible to the
 * next call on the other, which only holds while both resolve the same
 * `StoreEditor` and the same `MutablePropertyView`. Two separately-written
 * resolvers would satisfy the types and drift on exactly that.
 *
 * It also keeps `headless-backend.ts` inside its module-size budget.
 */

import {
  createCostStoreBackend,
  createGroupStoreBackend,
  createModellingStoreBackend,
  createOrdinaryStoreBackend,
  createStructuralStoreBackend,
  type CostBackendMethods,
  type CostStoreBackendMethods,
  type GroupStoreBackendMethods,
  type ModellingStoreBackendMethods,
  type OrdinaryStoreBackendMethods,
  type StructuralStoreBackendMethods,
} from '@ifc-lite/sdk';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';

export interface StoreAuthoringDeps {
  /** Throws when the caller names a model this backend does not answer for. */
  assertModel(modelId: string): void;
  defaultModelId: string;
  dataStore(): IfcDataStore;
  editor(): StoreEditor;
  mutationView(): MutablePropertyView;
  ownerHistoryId(): number | null;
  cost: Pick<CostBackendMethods, 'data'>;
}

export function createStoreAuthoring(
  deps: StoreAuthoringDeps,
): CostStoreBackendMethods & StructuralStoreBackendMethods & ModellingStoreBackendMethods & OrdinaryStoreBackendMethods & GroupStoreBackendMethods {
  const resolveModel = (modelId?: string) => {
    deps.assertModel(modelId ?? '');
    return {
      modelId: modelId ?? deps.defaultModelId,
      store: deps.dataStore(),
      editor: deps.editor(),
      mutationView: deps.mutationView(),
    };
  };
  const resolve = (modelId?: string) => ({ ...resolveModel(modelId), ownerHistoryId: deps.ownerHistoryId() });
  return {
    ...createCostStoreBackend(resolve, deps.cost),
    ...createGroupStoreBackend(resolve),
    ...createStructuralStoreBackend(resolve),
    ...createModellingStoreBackend(resolve),
    ...createOrdinaryStoreBackend(resolveModel),
  };
}
