/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `globePlacementSlice`'s contribution to the store teardown registry
 * (`store/teardown.ts`).
 *
 * Only the published status is session state: it describes the bridge of the
 * model that was on the globe. The Auto/Anchor/Exact choice is a per-browser
 * preference (persisted in localStorage) and survives a session reset, like
 * the Cesium data source. Models are not tracked per id, so the other scopes
 * do not apply.
 */

import { defineSliceTeardown, notApplicable } from '../teardown.js';

export const globePlacementTeardown = defineSliceTeardown(
  'globePlacementSlice',
  ['cesiumGlobePlacementStatus'],
  {
    'session-reset': () => ({ cesiumGlobePlacementStatus: null }),
    'model-removed': notApplicable,
    'all-models-cleared': notApplicable,
  },
);
