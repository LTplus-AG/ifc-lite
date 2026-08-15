/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The lazily-loaded CesiumJS module, shared by everything in the world view.
 *
 * Cesium is large enough that importing it eagerly would land in the initial
 * bundle, so it is pulled in on first activation and memoised here. Split out
 * of CesiumOverlay.tsx (#2593) because the model-lifecycle, solar and
 * camera-sync hooks all need the same instance — a second copy of this memo
 * would mean a second copy of Cesium.
 *
 * `getCesiumModule()` is the synchronous accessor for code that runs after the
 * viewer exists and therefore knows the load already resolved.
 */

let cesiumPromise: Promise<typeof import('cesium')> | null = null;
let cesiumModule: typeof import('cesium') | null = null;

export function loadCesium(): Promise<typeof import('cesium')> {
  if (!cesiumPromise) {
    cesiumPromise = Promise.all([
      import('cesium'),
      import('cesium/Build/Cesium/Widgets/widgets.css'),
    ]).then(([cesium]) => {
      cesiumModule = cesium;
      return cesium;
    });
  }
  return cesiumPromise;
}

/** The loaded module, or null before the first `loadCesium()` resolves. */
export function getCesiumModule(): typeof import('cesium') | null {
  return cesiumModule;
}
