/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `cesiumSlice`'s contribution to the store teardown registry (`store/teardown.ts`).
 *
 * SEPARATE FILE, not the bottom of `cesiumSlice.ts`, for one reason: that file
 * is 371 lines and the module-size ratchet (`scripts/check-module-size.mjs`,
 * limit 400, no allowlist row) leaves 29 lines of headroom — less than this
 * costs with its comments intact, and dropping the comments to fit is the one
 * thing the migration rules forbid. Splitting at the teardown seam beats
 * raising a budget; the seam is the one this refactor exists to create.
 *
 * Everything here is session-reset only. The Cesium overlay is not touched by
 * `removeModel`, `clearAllModels` or the resync purge today, so both
 * other scopes return `{}`.
 *
 * `resetCesiumPlacementDraft()` clears two of these eleven fields and stays as
 * it is: it is a user-facing "cancel the placement edit", not a teardown, and
 * folding it in would tie a UI action to a scope arm that will grow fields it
 * has no business clearing.
 */

import { defineSliceTeardown, notApplicable } from '../teardown.js';

export const cesiumTeardown = defineSliceTeardown(
  'cesiumSlice',
  [
    'cesiumAvailable',
    'cesiumEnabled',
    'cesiumTerrainHeight',
    'cesiumTerrainSaveHeight',
    'cesiumSourceModelId',
    'cesiumHeightsAreEllipsoidal',
    'cesiumTerrainClipY',
    'cesiumGlbLoaded',
    'cesiumPlacementEditMode',
    'cesiumPlacementDraftModelId',
    'cesiumPlacementDraft',
  ],
  {
    'session-reset': () => ({
      cesiumAvailable: false,
      cesiumEnabled: false,
      cesiumTerrainHeight: null,
      // The snap target is model-specific terrain state; drop it with the
      // sampled height so a new file can't reuse the old target (#1456).
      cesiumTerrainSaveHeight: null,
      cesiumSourceModelId: null,
      // A new file is orthometric by default — re-arm the geoid correction
      // so a previous file's "heights are ellipsoidal" opt-out doesn't carry
      // over (#1355).
      cesiumHeightsAreEllipsoidal: false,
      cesiumTerrainClipY: null,
      cesiumGlbLoaded: false,
      cesiumPlacementEditMode: false,
      cesiumPlacementDraftModelId: null,
      cesiumPlacementDraft: null,
    }),
    'model-removed': notApplicable,
    'all-models-cleared': notApplicable,
  },
);
