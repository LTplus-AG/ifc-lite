/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { CostStoreBackendMethods } from './store-cost-types.js';
import type { StructuralStoreBackendMethods } from './store-structural-types.js';
import type { ModellingStoreBackendMethods } from './store-modelling-types.js';
import type { GroupStoreBackendMethods } from './store-group-types.js';

/** Shared authoring capabilities keep the main backend declaration inside its size budget. */
export interface StoreAuthoringBackendMethods extends CostStoreBackendMethods, StructuralStoreBackendMethods, ModellingStoreBackendMethods, GroupStoreBackendMethods {}
