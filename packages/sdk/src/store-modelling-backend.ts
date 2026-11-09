/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.store`'s full modelling surface: everything
 * `createModellingStoreBackendWithoutStoreys` builds plus the storey methods.
 * The CLI and headless backends spread this. It is its own module so that a
 * host using only the storey-free factory does not link the storey planners
 * (#9200).
 */

import type { ModellingStoreBackendMethods } from './store-modelling-types.js';
import { createModellingStoreBackendWithoutStoreys, type ModellingStoreModelResolver } from './store-modelling-backend-without-storeys.js';
import { createStoreyStoreBackend } from './store-storey-backend.js';

export type { ModellingStoreModelResolver } from './store-modelling-backend-without-storeys.js';

export function createModellingStoreBackend(resolve: ModellingStoreModelResolver): ModellingStoreBackendMethods {
  return { ...createModellingStoreBackendWithoutStoreys(resolve), ...createStoreyStoreBackend(resolve) };
}
