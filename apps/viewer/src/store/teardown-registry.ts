/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The store's assembled teardown: every slice's contribution, in one list.
 *
 * `store/teardown.ts` defines the contract; this file is the only place that
 * says WHICH slices implement it. Both halves are exported:
 *
 *  - {@link viewerTeardownRegistry} — the declarations, so a test can pin the
 *    owned-key set. A migrator quietly dropping a key from an `owns` list is
 *    otherwise invisible: the key simply stops being cleared, and "state that
 *    was not cleared" is a failure with no smell.
 *  - {@link viewerTeardown} — the composed `(scope, state) => patch` the four
 *    entry points call.
 *
 * ## Why this is not `store/index.ts`
 *
 * `slices/modelSlice.ts` is one of the entry points (`removeModel`,
 * `clearAllModels`), and `index.ts` imports `modelSlice.ts` to build the
 * store. Putting the registry in `index.ts` would make that import cycle a
 * RUNTIME one — `createTeardownRegistry` runs at module init — so the registry
 * lives on its own, below both. Nothing here imports `index.ts`; the only tie
 * to it is `ViewerState`, a type, erased at build.
 *
 * ## Order
 *
 * Listed in the order `index.ts` spreads the slices, so the two lists can be
 * read side by side. Order does not decide any value: ownership is disjoint
 * and `createTeardownRegistry` proves it on import, so a key has exactly one
 * contributor and merge order only picks insertion order, which nothing
 * observes.
 *
 * ## Slices that are absent
 *
 * A slice with no entry is a slice no teardown path has ever written.
 * `measurementSlice` is the one deliberate exception: `resetViewerState` tears
 * it down by CALLING `resetAllMeasurementState()`, an action that owns the
 * full field list itself (see its doc comment for why that must not be
 * duplicated as a table), and an action is a side effect a pure teardown may
 * not perform. It stays at the entry point.
 */

import { composeTeardown, createTeardownRegistry, type AnySliceTeardown } from './teardown.js';

import { loadingTeardown } from './slices/loadingSlice.js';
import { selectionTeardown } from './slices/selectionSlice.teardown.js';
import { visibilityTeardown } from './slices/visibilitySlice.teardown.js';
import { uiTeardown } from './slices/uiSlice.teardown.js';
import { hoverTeardown } from './slices/hoverSlice.js';
import { cameraTeardown } from './slices/cameraSlice.js';
import { sectionTeardown } from './slices/sectionSlice.teardown.js';
import { dataTeardown } from './slices/dataSlice.teardown.js';
import { modelTeardown } from './slices/modelSlice.teardown.js';
import { mutationTeardown } from './slices/mutationSlice.teardown.js';
import { drawing2DTeardown } from './slices/drawing2DSlice.teardown.js';
import { sheetTeardown } from './slices/sheetSlice.teardown.js';
import { bcfTeardown } from './slices/bcfSlice.teardown.js';
import { idsTeardown } from './slices/idsSlice.teardown.js';
import { listTeardown } from './slices/listSlice.js';
import { pinboardTeardown } from './slices/pinboardSlice.teardown.js';
import { lensTeardown } from './slices/lensSlice.js';
import { compareTeardown } from './slices/compareSlice.js';
import { scriptTeardown } from './slices/scriptSlice.teardown.js';
import { chatTeardown } from './slices/chatSlice.teardown.js';
import { cesiumTeardown } from './slices/cesiumSlice.teardown.js';
import { scheduleTeardown } from './slices/scheduleSlice.teardown.js';
import { playbackTeardown } from './slices/playbackSlice.js';
import { searchTeardown } from './slices/searchSlice.teardown.js';
import { annotationsTeardown } from './slices/annotationsSlice.teardown.js';
import { addElementTeardown } from './slices/addElementSlice.teardown.js';
import { pointCloudTeardown } from './slices/pointCloudSlice.js';
import { zonesTeardown } from './slices/zonesSlice.js';

/**
 * Every slice teardown the viewer store knows about.
 *
 * Building this THROWS on import if two slices claim the same key, or one
 * lists a key twice — the exact defect this seam exists to remove, turned into
 * a failure every test sees rather than a silent double-write.
 */
export const viewerTeardownRegistry: readonly AnySliceTeardown[] = createTeardownRegistry([
  loadingTeardown,
  selectionTeardown,
  visibilityTeardown,
  uiTeardown,
  hoverTeardown,
  cameraTeardown,
  sectionTeardown,
  dataTeardown,
  modelTeardown,
  mutationTeardown,
  drawing2DTeardown,
  sheetTeardown,
  bcfTeardown,
  idsTeardown,
  listTeardown,
  pinboardTeardown,
  lensTeardown,
  compareTeardown,
  scriptTeardown,
  chatTeardown,
  cesiumTeardown,
  scheduleTeardown,
  playbackTeardown,
  searchTeardown,
  annotationsTeardown,
  addElementTeardown,
  pointCloudTeardown,
  zonesTeardown,
]);

/**
 * The one patch builder the four teardown entry points share.
 *
 * PURE: it returns a patch and writes nothing. The caller applies it through
 * the store's own `set` / `setState` — both wrapped by
 * `withVisibilityOwnershipInvalidation` — so a teardown write goes through the
 * shared-channel invalidation exactly like every other write.
 */
export const viewerTeardown = composeTeardown(viewerTeardownRegistry);
