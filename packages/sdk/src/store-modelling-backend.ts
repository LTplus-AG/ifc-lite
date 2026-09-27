/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Builds `bim.store`'s opening and hosted door/window methods (#6232), for the
 * same reason `createStructuralStoreBackend` exists: every host implementing
 * `StoreBackendMethods` (CLI headless backend, viewer store adapter) spreads
 * this in instead of re-deriving the host anchor and re-wiring the builders.
 *
 * The host is resolved per call through `resolveHostAnchor` against the host's
 * live mutation view, so a wall authored earlier in the same session can take
 * an opening exactly like one read from the file.
 */

import {
  addHostedDoorToStore,
  addHostedWindowToStore,
  addOpeningToStore,
  resolveHostAnchor,
  type HostedDoorInStoreParams,
  type HostedWindowInStoreParams,
  type OpeningInStoreParams,
} from '@ifc-lite/create';
import type { CostStoreModelResolution } from './cost-store-backend.js';
import type { ModellingStoreBackendMethods } from './store-modelling-types.js';
import type { EntityRef } from './types.js';

/** Same per-call resolution the cost and structural factories take. */
export type ModellingStoreModelResolver = (modelId?: string) => CostStoreModelResolution;

export function createModellingStoreBackend(resolve: ModellingStoreModelResolver): ModellingStoreBackendMethods {
  const host = (modelId: string, hostExpressId: number) => {
    const model = resolve(modelId);
    return { model, anchor: resolveHostAnchor(model.store, hostExpressId, model.mutationView) };
  };
  const ref = (modelId: string, expressId: number): EntityRef => ({ modelId, expressId });

  return {
    addOpening(modelId: string, hostExpressId: number, params: OpeningInStoreParams): EntityRef {
      const { model, anchor } = host(modelId, hostExpressId);
      return ref(model.modelId, addOpeningToStore(model.editor, anchor, params).openingId);
    },
    addHostedDoor(modelId: string, hostExpressId: number, params: HostedDoorInStoreParams): EntityRef {
      const { model, anchor } = host(modelId, hostExpressId);
      return ref(model.modelId, addHostedDoorToStore(model.editor, anchor, params).fillingId);
    },
    addHostedWindow(modelId: string, hostExpressId: number, params: HostedWindowInStoreParams): EntityRef {
      const { model, anchor } = host(modelId, hostExpressId);
      return ref(model.modelId, addHostedWindowToStore(model.editor, anchor, params).fillingId);
    },
  };
}
